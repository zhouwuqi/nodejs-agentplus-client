require('dotenv').config({ path: './.env' });
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const si = require('systeminformation');
const processManager = require('./process');

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

// 心跳控制
let heartbeatInProgress = false;
let heartbeatTimer = null;

// 心跳间隔配置（毫秒）
const DEFAULT_HEARTBEAT_INTERVAL = 5000;  // 默认模式：5秒
const MANAGED_HEARTBEAT_INTERVAL = 2000;  // 托管进程模式：2秒

// 设置进程管理器中的命令响应延迟
processManager.COMMAND_RESPONSE_DELAY = 1000;

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
    } else if (processManager.runningProcesses.size > 0) {
        // 如果有托管进程，使用托管进程模式的间隔
        nextDelay = MANAGED_HEARTBEAT_INTERVAL;
    } else {
        // 否则使用默认间隔
        nextDelay = DEFAULT_HEARTBEAT_INTERVAL;
    }
    
    console.log(`Scheduling next heartbeat in ${nextDelay}ms`);
    
    // 设置新的定时器
    heartbeatTimer = setTimeout(() => {
        if (!heartbeatInProgress && !processManager.processingTasks) {
            sendHeartbeat();
        } else {
            // 如果心跳或任务处理正在进行，重新安排
            scheduleNextHeartbeat(1000); // 1秒后重试
        }
    }, nextDelay);
}

// 将scheduleNextHeartbeat函数传递给processManager
processManager.scheduleNextHeartbeat = scheduleNextHeartbeat;

// 发送心跳
async function sendHeartbeat() {
    // 如果心跳正在进行或者正在处理任务，则跳过
    if (heartbeatInProgress || processManager.processingTasks) {
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
        const payload = processManager.prepareHeartbeatData(CLI_TOKEN);
        
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
                        if (processManager.runningProcesses.has(pid)) {
                            // 明确重置为false
                            processManager.processCommandExecuted.set(pid, false);
                            console.log(`Reset command executed flag for process ${pid} to false`);
                        }
                    }
                }
            }
            
            // 处理输出更新确认
            if (response.data.callback && response.data.callback.process_output_update_succeed) {
                for (const pid of response.data.callback.process_output_update_succeed) {
                    if (processManager.runningProcesses.has(pid)) {
                        processManager.processOutputBuffer.set(pid, '');
                        console.log(`Cleared output buffer for process ${pid}`);
                    }
                }
            }
            
            // 重置已发送的回调
            processManager.pendingCallbacks = {
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
                
                await processManager.processTasks(response.data.tasks, response.data.callback);
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
    // 获取进程状态信息
    const processStatus = processManager.getProcessStatus();
    
    const statusResponse = {
        ...lastHeartbeatStatus,
        processes: processStatus,
        pendingCallbacks: processManager.pendingCallbacks // 添加待确认回调信息，方便调试
    };
    
    res.json(statusResponse);
});

// 获取特定进程的输出
app.get('/process/:pid/output', (req, res) => {
    const { pid } = req.params;
    if (processManager.processOutputBuffer.has(pid)) {
        res.json({ output: processManager.processOutputBuffer.get(pid) });
    } else {
        res.status(404).json({ error: 'Process output not found' });
    }
});

// 手动创建新进程的API端点（用于测试）
app.post('/process/create', async (req, res) => {
    try {
        const pid = await processManager.createNewProcess();
        res.json({ success: true, pid });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 手动杀死进程的API端点（用于测试）
app.post('/process/:pid/kill', async (req, res) => {
    const { pid } = req.params;
    try {
        const result = await processManager.killProcess(pid);
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
        const result = await processManager.executeCommandInProcess(pid, command);
        res.json({ success: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 添加一个调试端点，用于检查命令执行状态
app.get('/debug/command-status', (req, res) => {
    const status = {};
    for (const [pid, executed] of processManager.processCommandExecuted.entries()) {
        status[pid] = {
            executed: executed,
            running: processManager.runningProcesses.has(pid)
        };
    }
    res.json(status);
});

// 添加一个端点，用于手动重置命令执行状态（仅用于调试）
app.post('/debug/reset-command-status/:pid', (req, res) => {
    const { pid } = req.params;
    if (processManager.runningProcesses.has(pid)) {
        processManager.processCommandExecuted.set(pid, false);
        res.json({ success: true, message: `Reset command executed flag for process ${pid}` });
    } else {
        res.status(404).json({ success: false, error: 'Process not found' });
    }
});

app.listen(INTERNAL_PORT, () => {
    console.log(`Backend status server listening on http://localhost:${INTERNAL_PORT}`);
});

// 注册退出处理程序
process.on('exit', processManager.cleanupProcesses);
process.on('SIGINT', () => {
    console.log('Received SIGINT. Cleaning up and exiting...');
    processManager.cleanupProcesses();
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.log('Received SIGTERM. Cleaning up and exiting...');
    processManager.cleanupProcesses();
    process.exit(0);
});

// --- Main Logic ---
console.log('Starting heartbeat service...');

// 初始心跳
sendHeartbeat();