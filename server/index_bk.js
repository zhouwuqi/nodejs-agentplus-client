require('dotenv').config({ path: './.env' });
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const si = require('systeminformation');
const { spawn } = require('child_process');
const process = require('process');

const app = express();
app.use(cors());
app.use(express.json());
const INTERNAL_PORT = 4000;

const { CLI_TOKEN, SERVER_URL } = process.env;

if (!CLI_TOKEN || !SERVER_URL) {
    console.error('Error: CLI_TOKEN and SERVER_URL must be set in the .env file.');
    // We don't exit the process because the frontend might still be useful.
}

let lastHeartbeatStatus = {
    status: 'Not yet sent',
    lastSent: null,
    response: null,
    error: null
};

// 进程管理
const runningProcesses = new Map(); // 存储运行中的进程
const processOutputBuffer = new Map(); // 存储进程输出缓冲
const processCommandExecuted = new Map(); // 跟踪每个进程是否执行了命令

// 心跳控制
let heartbeatInProgress = false;
let processingTasks = false;
let heartbeatTimer = null;

// 心跳间隔配置（毫秒）
const DEFAULT_HEARTBEAT_INTERVAL = 5000;  // 默认模式：5秒
const MANAGED_HEARTBEAT_INTERVAL = 2000;  // 托管进程模式：2秒
const COMMAND_RESPONSE_DELAY = 1000;      // 命令执行后等待时间：1秒

// 回调状态跟踪
let pendingCallbacks = {
    process_death: [],
    process_created: null
};

// 安排下一次心跳
function scheduleNextHeartbeat(delay = null) {
    // 清除现有的定时器
    if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
    }
    
    // 确定下一次心跳的延迟时间
    let nextDelay;
    
    if (delay !== null) {
        // 如果指定了延迟，使用指定的延迟
        nextDelay = delay;
    } else if (runningProcesses.size > 0) {
        // 如果有托管进程，使用托管进程模式的间隔
        nextDelay = MANAGED_HEARTBEAT_INTERVAL;
    } else {
        // 否则使用默认间隔
        nextDelay = DEFAULT_HEARTBEAT_INTERVAL;
    }
    
    console.log(`Scheduling next heartbeat in ${nextDelay}ms`);
    
    // 设置新的定时器
    heartbeatTimer = setTimeout(() => {
        if (!heartbeatInProgress && !processingTasks) {
            sendHeartbeat();
        } else {
            // 如果心跳或任务处理正在进行，重新安排
            scheduleNextHeartbeat(1000); // 1秒后重试
        }
    }, nextDelay);
}

// 修改处理进程输出的函数
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

// 创建新进程
async function createNewProcess() {
    try {
        // 指定工作目录，这里使用当前目录作为示例
        const workingDir = process.cwd();
        
        // 使用shell模式创建进程，这样可以执行实际命令
        const childProcess = spawn('bash', [], {
            cwd: workingDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true
        });
        
        const pid = childProcess.pid.toString();
        
        // 确保工作目录是绝对路径
        const absoluteWorkingDir = require('path').resolve(workingDir);
        childProcess.workingDirectory = absoluteWorkingDir; // 添加自定义属性存储工作目录
        
        // 初始化时间戳
        childProcess._lastOutputTime = Date.now();
        childProcess._lastStatusCheck = Date.now();
        
        childProcess.stdout.on('data', (data) => {
            handleProcessOutput(pid, data);
        });
        
        childProcess.stderr.on('data', (data) => {
            handleProcessOutput(pid, data, true);
        });
        
        childProcess.on('close', (code) => {
            console.log(`Process ${pid} exited with code ${code}`);
            runningProcesses.delete(pid);
            processCommandExecuted.delete(pid); // 删除命令执行标记
            processOutputBuffer.delete(pid); // 删除输出缓冲
            // 添加到待确认的进程死亡列表
            pendingCallbacks.process_death.push(pid);
            
            // 重新安排心跳，因为进程状态已改变
            scheduleNextHeartbeat();
        });
        
        runningProcesses.set(pid, childProcess);
        // 明确初始化命令执行标记为false
        processCommandExecuted.set(pid, false);
        processOutputBuffer.set(pid, ''); // 初始化输出缓冲为空字符串
        console.log(`Created new process with PID: ${pid} in directory: ${absoluteWorkingDir}`);
        
        // 设置待确认的新创建进程PID
        pendingCallbacks.process_created = pid;
        
        // 重新安排心跳，因为有了新进程
        scheduleNextHeartbeat();
        
        return pid;
    } catch (error) {
        console.error('Error creating new process:', error);
        throw error;
    }
}

// 在进程中执行命令
async function executeCommandInProcess(pid, command) {
    if (!runningProcesses.has(pid)) {
        throw new Error(`Process with PID ${pid} not found`);
    }
    
    try {
        const proc = runningProcesses.get(pid);
        if (proc.stdin) {
            // 检查是否是 cd 命令
            if (command.trim().startsWith('cd ')) {
                // 将 cd 命令和 pwd 命令一起发送，以获取新的工作目录
                proc.stdin.write(command + ' && pwd\n');
                
                // 添加一个标记，表示我们需要从输出中提取新的工作目录
                proc._expectPwd = true;
            } else {
                // 直接发送命令到进程
                proc.stdin.write(command + '\n');
            }
            
            // 明确设置命令执行标记为true
            processCommandExecuted.set(pid, true);
            console.log(`Process ${pid} command executed flag set to true`);
            
            // 安排快速心跳响应
            scheduleNextHeartbeat(COMMAND_RESPONSE_DELAY);
            
            return true;
        } else {
            const output = `[ERROR] Process does not support stdin\n`;
            handleProcessOutput(pid, output, true);
            return false;
        }
    } catch (error) {
        console.error(`Error executing command in process ${pid}:`, error);
        throw error;
    }
}

// 杀死进程
async function killProcess(pid) {
    if (!runningProcesses.has(pid)) {
        console.log(`Process ${pid} not found or already terminated`);
        return false; // 进程已经不存在
    }
    
    try {
        const proc = runningProcesses.get(pid);
        proc.kill();
        console.log(`Process ${pid} killed`);
        runningProcesses.delete(pid);
        processCommandExecuted.delete(pid); // 删除命令执行标记
        processOutputBuffer.delete(pid); // 删除输出缓冲
        
        // 添加到待确认的进程死亡列表
        pendingCallbacks.process_death.push(pid);
        
        // 重新安排心跳，因为进程状态已改变
        scheduleNextHeartbeat();
        
        return true;
    } catch (error) {
        console.error(`Error killing process ${pid}:`, error);
        throw error;
    }
}

// 确认进程是否存活
function confirmProcessAlive(pid) {
    return runningProcesses.has(pid);
}

// 处理服务器返回的任务
async function processTasks(tasks, callback) {
    if (!tasks) return pendingCallbacks;
    
    processingTasks = true;
    let commandExecuted = false;
    
    try {
        // 处理进程死亡确认
        if (tasks.confirm_process_death && Array.isArray(tasks.confirm_process_death)) {
            for (const pid of tasks.confirm_process_death) {
                if (!confirmProcessAlive(pid)) {
                    if (!pendingCallbacks.process_death.includes(pid)) {
                        pendingCallbacks.process_death.push(pid);
                    }
                    console.log(`Confirmed process ${pid} is no longer alive`);
                }
            }
        }
        
        // 处理新进程创建请求
        if (tasks.if_require_new_process === 1) {
            const newPid = await createNewProcess();
            pendingCallbacks.process_created = newPid;
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
                if (killed && !pendingCallbacks.process_death.includes(pid)) {
                    pendingCallbacks.process_death.push(pid);
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
        if (commandExecuted) {
            scheduleNextHeartbeat(COMMAND_RESPONSE_DELAY);
        }
    } catch (error) {
        console.error('Error processing tasks:', error);
    } finally {
        processingTasks = false;
    }
    
    return pendingCallbacks;
}

// 准备心跳数据
function prepareHeartbeatData() {
    // 准备进程输出数据
    const processOutput = [];
    
    // 遍历所有运行中的进程
    for (const [pid, proc] of runningProcesses.entries()) {
        const output = processOutputBuffer.has(pid) ? processOutputBuffer.get(pid) : "";
        const workingDir = proc ? (proc.workingDirectory || process.cwd()) : process.cwd();
        
        // 创建类似终端提示符的格式
        const username = require('os').userInfo().username;
        const hostname = require('os').hostname();
        const promptString = `${username}@${hostname}:${workingDir}# `;
        
        // 直接从processCommandExecuted获取状态，确保类型是数字
        const if_command_executed = processCommandExecuted.has(pid) && processCommandExecuted.get(pid) ? 1 : 0;
        
        // 检测进程当前状态
        let status = "idle"; // 默认状态为空闲
        
        try {
            // 检查进程是否存在
            if (proc && proc.pid) {
                // 使用process.kill(0)检查进程是否存活，不会实际终止进程
                process.kill(proc.pid, 0);
                
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
            // 如果process.kill抛出异常，说明进程不存在
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
        callback: { ...pendingCallbacks }
    };
}

// 发送心跳
async function sendHeartbeat() {
    // 如果心跳正在进行或者正在处理任务，则跳过
    if (heartbeatInProgress || processingTasks) {
        console.log('Skipping heartbeat - previous operation in progress');
        scheduleNextHeartbeat(1000); // 1秒后重试
        return;
    }
    
    heartbeatInProgress = true;
    
    if (!CLI_TOKEN || !SERVER_URL) {
        const errorMsg = 'Token or URL not configured.';
        console.error(errorMsg);
        lastHeartbeatStatus = {
            status: 'Failed',
            lastSent: new Date().toISOString(),
            response: null,
            error: errorMsg
        };
        heartbeatInProgress = false;
        scheduleNextHeartbeat();
        return;
    }

    try {
        // 准备心跳数据
        const payload = prepareHeartbeatData();
        
        // 异步获取系统信息
        payload.system_info = {
            os: await si.osInfo(),
            cpu: await si.cpu(),
            load: await si.currentLoad(),
            memory: await si.mem(),
            disks: await si.fsSize(),
        };

        // 在发送前打印完整的payload数据
        console.log('Heartbeat payload prepared:');
        // console.log(JSON.stringify(payload, null, 2));

        console.log('Sending heartbeat to server...');
        const response = await axios.post(SERVER_URL, payload);
        console.log('Heartbeat sent successfully.');
        
        // 检查是否有命令执行
        let commandExecuted = false;
        
        // 处理服务器返回的任务
        if (response.data && response.data.statusCode === 1) {
            // 处理命令执行确认回调
            if (response.data.callback && response.data.callback.command_executed_confirmed) {
                const confirmedPids = response.data.callback.command_executed_confirmed;
                if (Array.isArray(confirmedPids) && confirmedPids.length > 0) {
                    console.log(`Server confirmed command execution for PIDs: ${confirmedPids.join(', ')}`);
                    
                    // 重置已确认进程的命令执行标记
                    for (const pid of confirmedPids) {
                        if (runningProcesses.has(pid)) {
                            // 明确重置为false
                            processCommandExecuted.set(pid, false);
                            console.log(`Reset command executed flag for process ${pid} to false`);
                        }
                    }
                }
            }
            
            // 处理输出更新确认
            if (response.data.callback && response.data.callback.process_output_update_succeed) {
                for (const pid of response.data.callback.process_output_update_succeed) {
                    if (runningProcesses.has(pid)) {
                        processOutputBuffer.set(pid, '');
                        console.log(`Cleared output buffer for process ${pid}`);
                    }
                }
            }
            
            // 重置已发送的回调
            pendingCallbacks = {
                process_death: [],
                process_created: null
            };
            
            // 处理新任务
            if (response.data.tasks) {
                // 检查是否有命令需要执行
                if (response.data.tasks.command && Array.isArray(response.data.tasks.command) && 
                    response.data.tasks.command.length > 0) {
                    commandExecuted = true;
                }
                
                await processTasks(response.data.tasks, response.data.callback);
            }
        }
        
        lastHeartbeatStatus = {
            status: 'Success',
            lastSent: new Date().toISOString(),
            response: response.data,
            error: null
        };
        
        // 安排下一次心跳
        scheduleNextHeartbeat();
    } catch (error) {
        console.error('Error sending heartbeat:', error.message);
        lastHeartbeatStatus = {
            status: 'Failed',
            lastSent: new Date().toISOString(),
            response: null,
            error: error.message
        };
        scheduleNextHeartbeat(); // 出错后仍然安排下一次心跳
    } finally {
        heartbeatInProgress = false;
    }
}

// --- Internal API for the React Frontend ---
app.get('/status', (req, res) => {
    // 添加进程状态信息
    const processStatus = [];
    for (const [pid, proc] of runningProcesses.entries()) {
        // 获取与心跳相同的进程状态
        let status = "idle";
        try {
            if (proc && proc.pid) {
                process.kill(proc.pid, 0);
                
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
        
        processStatus.push({
            PID: pid,
            command: proc.spawnargs.join(' '),
            hasOutput: processOutputBuffer.has(pid) && processOutputBuffer.get(pid).length > 0,
            cwd: proc.workingDirectory || process.cwd(),
            commandExecuted: processCommandExecuted.has(pid) && processCommandExecuted.get(pid),
            status: status // 添加进程状态
        });
    }
    
    const statusResponse = {
        ...lastHeartbeatStatus,
        processes: processStatus,
        pendingCallbacks // 添加待确认回调信息，方便调试
    };
    
    res.json(statusResponse);
});

// 获取特定进程的输出
app.get('/process/:pid/output', (req, res) => {
    const { pid } = req.params;
    if (processOutputBuffer.has(pid)) {
        res.json({ output: processOutputBuffer.get(pid) });
    } else {
        res.status(404).json({ error: 'Process output not found' });
    }
});

// 手动创建新进程的API端点（用于测试）
app.post('/process/create', async (req, res) => {
    try {
        const pid = await createNewProcess();
        res.json({ success: true, pid });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 手动杀死进程的API端点（用于测试）
app.post('/process/:pid/kill', async (req, res) => {
    const { pid } = req.params;
    try {
        const result = await killProcess(pid);
        res.json({ success: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 手动执行命令的API端点（用于测试）
app.post('/process/:pid/execute', async (req, res) => {
    const { pid } = req.params;
    const { command } = req.body;
    
    if (!command) {
        return res.status(400).json({ success: false, error: 'Command is required' });
    }
    
    try {
        const result = await executeCommandInProcess(pid, command);
        res.json({ success: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 添加一个调试端点，用于检查命令执行状态
app.get('/debug/command-status', (req, res) => {
    const status = {};
    for (const [pid, executed] of processCommandExecuted.entries()) {
        status[pid] = {
            executed: executed,
            running: runningProcesses.has(pid)
        };
    }
    res.json(status);
});

// 添加一个端点，用于手动重置命令执行状态（仅用于调试）
app.post('/debug/reset-command-status/:pid', (req, res) => {
    const { pid } = req.params;
    if (runningProcesses.has(pid)) {
        processCommandExecuted.set(pid, false);
        res.json({ success: true, message: `Reset command executed flag for process ${pid}` });
    } else {
        res.status(404).json({ success: false, error: 'Process not found' });
    }
});

app.listen(INTERNAL_PORT, () => {
    console.log(`Backend status server listening on http://localhost:${INTERNAL_PORT}`);
});

// 在程序退出时清理所有子进程
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

// 注册退出处理程序
process.on('exit', cleanupProcesses);
process.on('SIGINT', () => {
    console.log('Received SIGINT. Cleaning up and exiting...');
    cleanupProcesses();
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.log('Received SIGTERM. Cleaning up and exiting...');
    cleanupProcesses();
    process.exit(0);
});

// --- Main Logic ---
console.log('Starting heartbeat service...');

// 初始心跳
sendHeartbeat();