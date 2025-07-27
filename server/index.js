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

// 心跳控制
let heartbeatInProgress = false;
let processingTasks = false;

// 回调状态跟踪 - 关键修复：添加专门的回调状态对象
let pendingCallbacks = {
    process_death: [],
    process_created: null
};

// 处理进程输出
function handleProcessOutput(pid, data, isError = false) {
    if (!processOutputBuffer.has(pid)) {
        processOutputBuffer.set(pid, '');
    }
    
    const output = data.toString();
    let currentBuffer = processOutputBuffer.get(pid);
    
    // 限制缓冲区大小，例如只保留最新的10KB数据
    const MAX_BUFFER_SIZE = 10 * 1024; // 10KB
    currentBuffer += (isError ? `[ERROR] ${output}` : output);
    
    // 如果超出大小限制，截取最新部分
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
        
        // 使用一个不会产生太多输出的命令
        const childProcess = spawn('node', ['-e', `
            console.log("New process started");
            // 只在收到命令时输出，不再自动产生心跳消息
            process.stdin.on('data', (data) => {
                console.log("Received command: " + data.toString().trim());
            });
        `], {
            cwd: workingDir,
            stdio: ['pipe', 'pipe', 'pipe'] // 确保stdin是可写的
        });
        
        const pid = childProcess.pid.toString();
        
        // 存储进程信息，包括工作目录
        childProcess.workingDirectory = workingDir; // 添加自定义属性存储工作目录
        
        childProcess.stdout.on('data', (data) => {
            handleProcessOutput(pid, data);
        });
        
        childProcess.stderr.on('data', (data) => {
            handleProcessOutput(pid, data, true);
        });
        
        childProcess.on('close', (code) => {
            console.log(`Process ${pid} exited with code ${code}`);
            runningProcesses.delete(pid);
            // 关键修复：添加到待确认的进程死亡列表
            pendingCallbacks.process_death.push(pid);
        });
        
        runningProcesses.set(pid, childProcess);
        console.log(`Created new process with PID: ${pid} in directory: ${workingDir}`);
        
        // 关键修复：设置待确认的新创建进程PID
        pendingCallbacks.process_created = pid;
        
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
        // 这里简化处理，实际上可能需要根据进程类型选择不同的命令注入方式
        const proc = runningProcesses.get(pid);
        if (proc.stdin) {
            proc.stdin.write(command + '\n');
            handleProcessOutput(pid, `[COMMAND EXECUTED] ${command}\n`);
            return true;
        } else {
            // 如果进程不支持stdin，记录一个模拟的执行结果
            const output = `[COMMAND SIMULATION] ${command} executed at ${new Date().toISOString()}\n`;
            handleProcessOutput(pid, output);
            return true;
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
        
        // 关键修复：添加到待确认的进程死亡列表
        pendingCallbacks.process_death.push(pid);
        
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
    } catch (error) {
        console.error('Error processing tasks:', error);
    } finally {
        processingTasks = false;
    }
    
    // 处理输出缓冲清理
    if (callback && callback.process_output_update_succeed && Array.isArray(callback.process_output_update_succeed)) {
        for (const pid of callback.process_output_update_succeed) {
            console.log(`Clearing output buffer for process ${pid} as server confirmed receipt`);
            processOutputBuffer.set(pid, '');
        }
    }
    
    return pendingCallbacks;
}


// 准备心跳数据
function prepareHeartbeatData() {
    // 准备进程输出数据
    const processOutput = [];
    for (const [pid, output] of processOutputBuffer.entries()) {
        if (output) {
            const proc = runningProcesses.get(pid);
            const workingDir = proc ? (proc.workingDirectory || process.cwd()) : process.cwd();
            
            // 创建类似终端提示符的格式
            const username = require('os').userInfo().username;
            const hostname = require('os').hostname();
            const promptString = `${username}@${hostname}:${workingDir}# `;
            
            processOutput.push({
                PID: pid,
                temp: output,
                cwd: promptString  // 使用终端风格的提示符替代原来的工作目录
            });
        }
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
        callback: { ...pendingCallbacks } // 关键修复：使用当前的待确认回调
    };
}


// 发送心跳
async function sendHeartbeat() {
    // 如果心跳正在进行或者正在处理任务，则跳过
    if (heartbeatInProgress || processingTasks) {
        console.log('Skipping heartbeat - previous operation in progress');
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

        console.log('Sending heartbeat to server...');
        console.log(payload); // 调试输出
        
        const response = await axios.post(SERVER_URL, payload);
        console.log('Heartbeat sent successfully.');
        
        // 处理服务器返回的任务
        if (response.data && response.data.statusCode === 1) {
            // 服务器确认接收，清空已发送的回调
            if (response.data.callback && response.data.callback.process_output_update_succeed) {
                // 清空已确认的输出缓冲
                for (const pid of response.data.callback.process_output_update_succeed) {
                    processOutputBuffer.set(pid, '');
                }
            }
            
            // 关键修复：重置已发送的回调，避免重复发送
            pendingCallbacks = {
                process_death: [],
                process_created: null
            };
            
            // 处理新任务
            await processTasks(response.data.tasks, response.data.callback);
        }
        
        lastHeartbeatStatus = {
            status: 'Success',
            lastSent: new Date().toISOString(),
            response: response.data,
            error: null
        };
    } catch (error) {
        console.error('Error sending heartbeat:', error.message);
        lastHeartbeatStatus = {
            status: 'Failed',
            lastSent: new Date().toISOString(),
            response: null,
            error: error.message
        };
    } finally {
        heartbeatInProgress = false;
    }
}

// --- Internal API for the React Frontend ---
app.get('/status', (req, res) => {
    // 添加进程状态信息
    const processStatus = [];
    for (const [pid, proc] of runningProcesses.entries()) {
        processStatus.push({
            PID: pid,
            command: proc.spawnargs.join(' '),
            hasOutput: processOutputBuffer.has(pid) && processOutputBuffer.get(pid).length > 0,
            cwd: proc.workingDirectory || process.cwd() // 使用存储的工作目录
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
const heartbeatInterval = setInterval(() => {
    if (!heartbeatInProgress && !processingTasks) {
        sendHeartbeat();
    }
}, 5000);

// 初始心跳
sendHeartbeat();