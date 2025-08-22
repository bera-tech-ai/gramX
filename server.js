const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.json());
app.use(express.static('public'));

// In-memory storage (no MongoDB needed)
const users = new Map(); // username -> password
const messages = [];
const activeUsers = new Map(); // socket.id -> username

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API Routes
app.post('/register', (req, res) => {
    const { username, password } = req.body;
    
    if (users.has(username)) {
        return res.json({ success: false, error: 'Username taken' });
    }
    
    users.set(username, password);
    res.json({ success: true, username });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    if (users.has(username) && users.get(username) === password) {
        res.json({ success: true, username });
    } else {
        res.json({ success: false, error: 'Invalid credentials' });
    }
});

// Socket.io handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('user-login', (username) => {
        activeUsers.set(socket.id, username);
        socket.broadcast.emit('user-joined', username);
        socket.emit('message-history', messages);
    });

    socket.on('send-message', (data) => {
        const message = {
            text: data.text,
            sender: data.sender,
            timestamp: new Date(),
            id: Date.now() + Math.random()
        };
        
        messages.push(message);
        // Keep only last 100 messages
        if (messages.length > 100) messages.shift();

        io.emit('new-message', message);
    });

    socket.on('disconnect', () => {
        const username = activeUsers.get(socket.id);
        if (username) {
            activeUsers.delete(socket.id);
            socket.broadcast.emit('user-left', username);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 gramX server running on port ${PORT}`);
    console.log(`📱 Open http://localhost:${PORT} in your browser`);
});
