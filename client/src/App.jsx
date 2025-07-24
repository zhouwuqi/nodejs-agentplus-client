import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';

function App() {
    const [status, setStatus] = useState({});
    const [error, setError] = useState(null);

    useEffect(() => {
        const fetchStatus = async () => {
            try {
                // The backend status server is running on port 4000
                const response = await axios.get('http://localhost:4000/status');
                setStatus(response.data);
                setError(null);
            } catch (err) {
                setError('Could not connect to the backend status server. Is it running?');
                console.error(err);
            }
        };

        const intervalId = setInterval(fetchStatus, 1000); // Poll for status frequently
        fetchStatus(); // Initial fetch

        return () => clearInterval(intervalId);
    }, []);

    const getStatusColor = () => {
        if (status.status === 'Success') return '#28a745'; // Green
        if (status.status === 'Failed') return '#dc3545'; // Red
        return '#6c757d'; // Gray
    };

    return (
        <div className="App">
            <header className="App-header">
                <h1>AgentplusCli Status</h1>
                <p>This page shows the status of the background heartbeat process.</p>
            </header>
            <div className="status-card">
                <h2>Heartbeat Status</h2>
                <div className="status-indicator">
                    <span className="status-light" style={{ backgroundColor: getStatusColor() }}></span>
                    <p><strong>Status:</strong> {status.status || 'Loading...'}</p>
                </div>
                <p><strong>Last Sent:</strong> {status.lastSent ? new Date(status.lastSent).toLocaleString() : 'N/A'}</p>
                
                <h3>Last Response:</h3>
                <pre className="response-box">
                    {status.error ? `Error: ${status.error}` : JSON.stringify(status.response, null, 2) || 'No response yet.'}
                </pre>

                {error && <p className="error-message">{error}</p>}
            </div>
        </div>
    );
}

export default App;
