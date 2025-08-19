/**
 * process.js
 * 
 * 进程管理模块 - 负责创建、监控、执行命令和终止子进程
 * 
 * 该模块提供了一套完整的进程管理功能，包括：
 * - 创建新的子进程
 * - 在子进程中执行命令
 * - 捕获和管理子进程的输出
 * - 监控子进程状态
 * - 终止子进程
 * - 准备进程相关的心跳数据
 * 
 * 该模块与主应用程序(index.js)协同工作，处理所有与进程相关的操作，
 * 使主程序可以专注于API和通信逻辑。
 */

const pty = require('node-pty');
const process = require('process');
const os = require('os');
const path = require('path');

// 进程管理数据结构
const runningProcesses = new Map(); // 存储运行中的进程，键为PID，值为进程对象
const processOutputBuffer = new Map(); // 存储进程输出缓冲，键为PID，值为输出字符串
const processCommandExecuted = new Map(); // 跟踪每个进程是否执行了命令，键为PID，值为布尔值

/**
 * 处理进程输出
 * 
 * @param {string} pid - 进程ID
 * @param {string} data - 输出数据
 * @param {boolean} isError - 是否是错误输出 (node-pty不区分stdout和stderr，此参数保留以兼容现有结构)
 */
function handleProcessOutput(pid, data, isError = false) {
    if (!processOutputBuffer.has(pid)) {
        processOutputBuffer.set(pid, '');
    }
    
    const output = data.toString();
    let currentBuffer = processOutputBuffer.get(pid);
    
    // 检查是否需要提取新的工作目录
    const proc = runningProcesses.get(pid);
    if (proc) {
        // 记录最后输出时间
        proc._lastOutputTime = Date.now();
        
        if (proc._expectPwd && !isError) {
            const lines = output.trim().split('\n');
            if (lines.length > 0) {
                const possiblePath = lines[lines.length - 1].trim();
                // 简单验证这是否看起来像一个路径
                if (possiblePath.startsWith('/') || /^[A-Z]:\\/.test(possiblePath)) {
                    proc.workingDirectory = possiblePath;
                    proc._expectPwd = false;
                    console.log(`Updated working directory for process ${pid} to: ${possiblePath}`);
                    
                    // 从输出中移除 pwd 命令的结果
                    const outputWithoutPwd = output.substring(0, output.lastIndexOf(possiblePath));
                    currentBuffer += (isError ? `[ERROR] ${outputWithoutPwd}` : outputWithoutPwd);
                } else {
                    currentBuffer += (isError ? `[ERROR] ${output}` : output);
                }
            } else {
                currentBuffer += (isError ? `[ERROR] ${output}` : output);
            }
        } else {
            // 正常处理输出
            currentBuffer += (isError ? `[ERROR] ${output}` : output);
        }
    } else {
        // 正常处理输出
        currentBuffer += (isError ? `[ERROR] ${output}` : output);
    }
    
    // 限制缓冲区大小，例如只保留最新的10KB数据
    const MAX_BUFFER_SIZE = 10 * 1024; // 10KB
    if (currentBuffer.length > MAX_BUFFER_SIZE) {
        currentBuffer = currentBuffer.substring(currentBuffer.length - MAX_BUFFER_SIZE);
    }
    
    processOutputBuffer.set(pid, currentBuffer);
    console.log(`Process ${pid} ${isError ? 'error' : 'output'}: ${output.trim()}`);
}

/**
 * 创建新进程
 * 
 * 创建一个新的bash子进程，并设置相关的事件监听器
 * 
 * @returns {Promise<string>} 返回新创建进程的PID
 * @throws {Error} 如果创建进程失败
 */
async function createNewProcess() {
    try {
        // 指定工作目录，这里使用当前目录作为示例
        const workingDir = process.cwd();
        
        // 确保工作目录是绝对路径
        const absoluteWorkingDir = path.resolve(workingDir);
        
        // 使用node-pty创建伪终端
        const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
        const ptyProcess = pty.spawn(shell, [], {
            name: 'xterm-color',
            cols: 80,
            rows: 30,
            cwd: absoluteWorkingDir,
            env: process.env
        });
        
        const pid = ptyProcess.pid.toString();
        
        // 添加自定义属性存储工作目录
        ptyProcess.workingDirectory = absoluteWorkingDir;
        
        // 初始化时间戳
        ptyProcess._lastOutputTime = Date.now();
        ptyProcess._lastStatusCheck = Date.now();
        
        // 设置数据监听器 (node-pty只有一个data事件，不区分stdout和stderr)
        ptyProcess.onData((data) => {
            handleProcessOutput(pid, data);
        });
        
        // 设置进程退出监听器
        ptyProcess.onExit(({ exitCode, signal }) => {
            console.log(`Process ${pid} exited with code ${exitCode} and signal ${signal}`);
            runningProcesses.delete(pid);
            processCommandExecuted.delete(pid); // 删除命令执行标记
            processOutputBuffer.delete(pid); // 删除输出缓冲
            // 添加到待确认的进程死亡列表
            module.exports.pendingCallbacks.process_death.push(pid);
            
            // 重新安排心跳，因为进程状态已改变
            if (module.exports.scheduleNextHeartbeat) {
                module.exports.scheduleNextHeartbeat();
            }
        });
        
        // 将进程添加到管理集合中
        runningProcesses.set(pid, ptyProcess);
        // 明确初始化命令执行标记为false
        processCommandExecuted.set(pid, false);
        processOutputBuffer.set(pid, ''); // 初始化输出缓冲为空字符串
        console.log(`Created new process with PID: ${pid} in directory: ${absoluteWorkingDir}`);
        
        // 设置待确认的新创建进程PID
        module.exports.pendingCallbacks.process_created = pid;
        
        // 重新安排心跳，因为有了新进程
        if (module.exports.scheduleNextHeartbeat) {
            module.exports.scheduleNextHeartbeat();
        }
        
        return pid;
    } catch (error) {
        console.error('Error creating new process:', error);
        throw error;
    }
}

/**
 * 在进程中执行命令
 * 
 * @param {string} pid - 目标进程ID
 * @param {string} command - 要执行的命令
 * @returns {Promise<boolean>} 命令是否成功发送
 * @throws {Error} 如果进程不存在或执行命令失败
 */
async function executeCommandInProcess(pid, command) {
    if (!runningProcesses.has(pid)) {
        throw new Error(`Process with PID ${pid} not found`);
    }
    
    try {
        const proc = runningProcesses.get(pid);
        
        // 检查是否是 cd 命令
        if (command.trim().startsWith('cd ')) {
            // 将 cd 命令和 pwd 命令一起发送，以获取新的工作目录
            proc.write(command + ' && pwd\n');
            
            // 添加一个标记，表示我们需要从输出中提取新的工作目录
            proc._expectPwd = true;
        } else {
            // 直接发送命令到进程
            proc.write(command + '\n');
        }
        
        // 明确设置命令执行标记为true
        processCommandExecuted.set(pid, true);
        console.log(`Process ${pid} command executed flag set to true`);
        
        // 安排快速心跳响应
        if (module.exports.scheduleNextHeartbeat && module.exports.COMMAND_RESPONSE_DELAY) {
            module.exports.scheduleNextHeartbeat(module.exports.COMMAND_RESPONSE_DELAY);
        }
        
        return true;
    } catch (error) {
        console.error(`Error executing command in process ${pid}:`, error);
        throw error;
    }
}

/**
 * 杀死指定的进程
 * 
 * @param {string} pid - 要终止的进程ID
 * @returns {Promise<boolean>} 是否成功终止进程
 * @throws {Error} 如果终止进程时发生错误
 */
async function killProcess(pid) {
    if (!runningProcesses.has(pid)) {
        console.log(`Process ${pid} not found or already terminated`);
        return false; // 进程已经不存在
    }
    
    try {
        const proc = runningProcesses.get(pid);
        proc.kill(); // node-pty的kill方法
        console.log(`Process ${pid} killed`);
        runningProcesses.delete(pid);
        processCommandExecuted.delete(pid); // 删除命令执行标记
        processOutputBuffer.delete(pid); // 删除输出缓冲
        
        // 添加到待确认的进程死亡列表
        module.exports.pendingCallbacks.process_death.push(pid);
        
        // 重新安排心跳，因为进程状态已改变
        if (module.exports.scheduleNextHeartbeat) {
            module.exports.scheduleNextHeartbeat();
        }
        
        return true;
    } catch (error) {
        console.error(`Error killing process ${pid}:`, error);
        throw error;
    }
}

/**
 * 确认进程是否存活
 * 
 * @param {string} pid - 要检查的进程ID
 * @returns {boolean} 进程是否存活
 */
function confirmProcessAlive(pid) {
    return runningProcesses.has(pid);
}

/**
 * 处理服务器返回的任务
 * 
 * 根据服务器返回的任务指令执行相应的操作，如创建进程、执行命令、终止进程等
 * 
 * @param {Object} tasks - 服务器返回的任务对象
 * @param {Object} callback - 服务器返回的回调信息
 * @returns {Promise<Object>} 待确认的回调信息
 */
async function processTasks(tasks, callback) {
    if (!tasks) return module.exports.pendingCallbacks;
    
    module.exports.processingTasks = true;
    let commandExecuted = false;
    
    try {
        // 处理进程死亡确认
        if (tasks.confirm_process_death && Array.isArray(tasks.confirm_process_death)) {
            for (const pid of tasks.confirm_process_death) {
                if (!confirmProcessAlive(pid)) {
                    if (!module.exports.pendingCallbacks.process_death.includes(pid)) {
                        module.exports.pendingCallbacks.process_death.push(pid);
                    }
                    console.log(`Confirmed process ${pid} is no longer alive`);
                }
            }
        }
        
        // 处理新进程创建请求
        if (tasks.if_require_new_process === 1) {
            const newPid = await createNewProcess();
            module.exports.pendingCallbacks.process_created = newPid;
        }
        
        // 处理命令执行
        if (tasks.command && Array.isArray(tasks.command)) {
            for (const cmd of tasks.command) {
                if (cmd.PID && cmd.command) {
                    await executeCommandInProcess(cmd.PID, cmd.command);
                    console.log(`Executed command in process ${cmd.PID}: ${cmd.command}`);
                    commandExecuted = true;
                }
            }
        }
        
        // 处理进程终止请求
        if (tasks.kill_process && Array.isArray(tasks.kill_process)) {
            for (const pid of tasks.kill_process) {
                const killed = await killProcess(pid);
                if (killed && !module.exports.pendingCallbacks.process_death.includes(pid)) {
                    module.exports.pendingCallbacks.process_death.push(pid);
                }
            }
        }
        
        // 处理命令执行确认
        if (callback && callback.command_executed_confirmed && Array.isArray(callback.command_executed_confirmed)) {
            for (const pid of callback.command_executed_confirmed) {
                if (runningProcesses.has(pid)) {
                    processCommandExecuted.set(pid, false);
                    console.log(`[processTasks] Reset command executed flag for process ${pid} to false`);
                }
            }
        }
        
        // 如果执行了命令，安排快速心跳响应
        if (commandExecuted && module.exports.scheduleNextHeartbeat && module.exports.COMMAND_RESPONSE_DELAY) {
            module.exports.scheduleNextHeartbeat(module.exports.COMMAND_RESPONSE_DELAY);
        }
    } catch (error) {
        console.error('Error processing tasks:', error);
    } finally {
        module.exports.processingTasks = false;
    }
    
    return module.exports.pendingCallbacks;
}

/**
 * 准备心跳数据
 * 
 * 收集所有进程的状态和输出信息，准备发送给服务器
 * 
 * @param {string} CLI_TOKEN - 客户端认证令牌
 * @returns {Object} 包含系统信息和进程状态的心跳数据
 */
function prepareHeartbeatData(CLI_TOKEN) {
    // 准备进程输出数据
    const processOutput = [];
    
    // 遍历所有运行中的进程
    for (const [pid, proc] of runningProcesses.entries()) {
        const output = processOutputBuffer.has(pid) ? processOutputBuffer.get(pid) : "";
        const workingDir = proc ? (proc.workingDirectory || process.cwd()) : process.cwd();
        
        // 创建类似终端提示符的格式
        const username = os.userInfo().username;
        const hostname = os.hostname();
        const promptString = `${username}@${hostname}:${workingDir}# `;
        
        // 直接从processCommandExecuted获取状态，确保类型是数字
        const if_command_executed = processCommandExecuted.has(pid) && processCommandExecuted.get(pid) ? 1 : 0;
        
        // 检测进程当前状态
        let status = "idle"; // 默认状态为空闲
        
        try {
            // 检查进程是否存在
            if (proc && proc.pid) {
                // node-pty没有直接的方法检查进程是否存活，但如果进程在Map中，我们假设它是活的
                // 因为onExit会在进程终止时从Map中删除它
                
                // 检查进程是否有最近的输出变化
                const hasRecentOutput = processOutputBuffer.has(pid) && 
                                       processOutputBuffer.get(pid).length > 0 && 
                                       Date.now() - (proc._lastOutputTime || 0) < 5000; // 5秒内有输出
                
                if (if_command_executed) {
                    status = "executing"; // 正在执行命令
                } else if (hasRecentOutput) {
                    status = "active"; // 有最近输出但没有执行命令
                }
                // 否则保持idle状态
            } else {
                status = "terminated"; // 进程不存在或已终止
            }
        } catch (e) {
            // 如果发生异常，假设进程已终止
            status = "terminated";
        }
        
        // 更新最后检查时间
        if (proc) {
            proc._lastStatusCheck = Date.now();
        }
        
        // 调试日志
        console.log(`Preparing heartbeat for PID ${pid}, status=${status}, command_executed=${if_command_executed}`);
        
        processOutput.push({
            PID: pid,
            temp: output,
            cwd: promptString,
            if_command_executed: if_command_executed,
            status: status // 添加进程状态属性
        });
    }
    
    return {
        cli_token: CLI_TOKEN,
        system_info: {
            os: null, // 将在发送前异步填充
            cpu: null,
            load: null,
            memory: null,
            disks: null,
        },
        process_output: processOutput,
        callback: { ...module.exports.pendingCallbacks }
    };
}

/**
 * 清理所有子进程
 * 
 * 在程序退出前终止所有运行中的子进程
 */
function cleanupProcesses() {
    console.log('Cleaning up processes before exit...');
    for (const [pid, proc] of runningProcesses.entries()) {
        try {
            proc.kill();
            console.log(`Process ${pid} terminated`);
        } catch (error) {
            console.error(`Error terminating process ${pid}:`, error);
        }
    }
}

/**
 * 获取所有进程的状态信息
 * 
 * 用于API响应，提供所有进程的详细状态
 * 
 * @returns {Array} 进程状态信息数组
 */
function getProcessStatus() {
    const processStatus = [];
    for (const [pid, proc] of runningProcesses.entries()) {
        // 获取与心跳相同的进程状态
        let status = "idle";
        try {
            if (proc && proc.pid) {
                // node-pty没有直接的方法检查进程是否存活，但如果进程在Map中，我们假设它是活的
                
                const hasRecentOutput = processOutputBuffer.has(pid) && 
                                       processOutputBuffer.get(pid).length > 0 && 
                                       Date.now() - (proc._lastOutputTime || 0) < 5000;
                
                if (processCommandExecuted.has(pid) && processCommandExecuted.get(pid)) {
                    status = "executing";
                } else if (hasRecentOutput) {
                    status = "active";
                }
            } else {
                status = "terminated";
            }
        } catch (e) {
            status = "terminated";
        }
        
        // 为了保持与原代码结构一致，我们需要模拟spawnargs属性
        const shellName = process.platform === 'win32' ? 'powershell.exe' : 'bash';
        const spawnargs = [shellName];
        
        processStatus.push({
            PID: pid,
            command: spawnargs.join(' '),
            hasOutput: processOutputBuffer.has(pid) && processOutputBuffer.get(pid).length > 0,
            cwd: proc.workingDirectory || process.cwd(),
            commandExecuted: processCommandExecuted.has(pid) && processCommandExecuted.get(pid),
            status: status
        });
    }
    
    return processStatus;
}

// 回调状态跟踪
const pendingCallbacks = {
    process_death: [],
    process_created: null
};

// 导出模块
module.exports = {
    runningProcesses,
    processOutputBuffer,
    processCommandExecuted,
    pendingCallbacks,
    processingTasks: false,
    COMMAND_RESPONSE_DELAY: 1000,
    scheduleNextHeartbeat: null, // 将在index.js中设置
    
    handleProcessOutput,
    createNewProcess,
    executeCommandInProcess,
    killProcess,
    confirmProcessAlive,
    processTasks,
    prepareHeartbeatData,
    cleanupProcesses,
    getProcessStatus
};