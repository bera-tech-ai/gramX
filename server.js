const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Connect to MongoDB
mongoose.connect('mongodb://localhost:27017/gramx', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});

// User Schema
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    isOnline: { type: Boolean, default: false }
});

const messageSchema = new mongoose.Schema({
    text: String,
    sender: String,
    timestamp: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// Store active users and messages in memory for simplicity
const activeUsers = new Map();
let messages = [];

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API Routes
app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = new User({ username, password: hashedPassword });
        await user.save();
        res.json({ success: true, username });
    } catch (error) {
        res.json({ success: false, error: 'Username taken' });
    }
});

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        
        if (user && await bcrypt.compare(password, user.password)) {
            res.json({ success: true, username });
        } else {
            res.json({ success: false, error: 'Invalid credentials' });
        }
    } catch (error) {
        res.json({ success: false, error: 'Login failed' });
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
            timestamp: new Date()
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

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 gramX server running on http://localhost:${PORT}`);
});
