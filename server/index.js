require('dotenv').config({ path: './.env' });
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const si = require('systeminformation');

const app = express();
app.use(cors());
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

async function sendHeartbeat() {
    if (!CLI_TOKEN || !SERVER_URL) {
        const errorMsg = 'Token or URL not configured.';
        console.error(errorMsg);
        lastHeartbeatStatus = {
            status: 'Failed',
            lastSent: new Date().toISOString(),
            response: null,
            error: errorMsg
        };
        return;
    }

    try {
        const payload = {
            cli_token: CLI_TOKEN,
            system_info: {
                os: await si.osInfo(),
                cpu: await si.cpu(),
                load: await si.currentLoad(),
                memory: await si.mem(),
            }
        };

        const response = await axios.post(SERVER_URL, payload);
        console.log('Heartbeat sent successfully. Server response:', response.data);
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
    }
}

// --- Internal API for the React Frontend ---
app.get('/status', (req, res) => {
    res.json(lastHeartbeatStatus);
});

app.listen(INTERNAL_PORT, () => {
    console.log(`Backend status server listening on http://localhost:${INTERNAL_PORT}`);
});

// --- Main Logic ---
console.log('Starting heartbeat service...');
setInterval(sendHeartbeat, 5000);
sendHeartbeat(); // Initial send
