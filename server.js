const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/gramx', {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.log(err));

// User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  email: { type: String, unique: true, sparse: true },
  phone: { type: String, unique: true, sparse: true },
  passwordHash: { type: String, required: true },
  profilePhotoUrl: { type: String, default: '' },
  about: { type: String, default: 'Hey there! I\'m using GramX' },
  settings: {
    theme: { type: String, default: 'dark' },
    privacy: {
      lastSeen: { type: String, default: 'contacts' },
      profilePhoto: { type: String, default: 'everyone' },
      readReceipts: { type: Boolean, default: true }
    },
    notifications: {
      muteChats: { type: Array, default: [] },
      pushEnabled: { type: Boolean, default: true }
    }
  },
  lastSeen: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

// Message Schema
const messageSchema = new mongoose.Schema({
  chatId: { type: String, required: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, default: 'text' },
  message: { type: String, default: '' },
  mediaUrl: { type: String, default: '' },
  timestamp: { type: Date, default: Date.now },
  status: { type: String, default: 'sent' },
  reactions: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    emoji: { type: String }
  }],
  disappearing: {
    isActive: { type: Boolean, default: false },
    duration: { type: Number, default: 0 } // in seconds
  }
});

// Status Schema (Stories)
const statusSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, required: true },
  mediaUrl: { type: String, required: true },
  caption: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  views: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
});

// Chat Schema
const chatSchema = new mongoose.Schema({
  type: { type: String, default: 'private' },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  lastMessageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  updatedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const Status = mongoose.model('Status', statusSchema);
const Chat = mongoose.model('Chat', chatSchema);

// Authentication middleware
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'gramx_secret');
    const user = await User.findById(decoded.userId).select('-passwordHash');
    if (!user) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// Routes
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, phone, password } = req.body;
    
    if (!username || !password || (!email && !phone)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if user exists
    const existingUser = await User.findOne({
      $or: [{ email }, { phone }]
    });

    if (existingUser) {
      return res.status(409).json({ error: 'User already exists' });
    }

    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create user
    const newUser = new User({
      username,
      email: email || null,
      phone: phone || null,
      passwordHash
    });

    await newUser.save();

    // Generate JWT
    const token = jwt.sign(
      { userId: newUser._id },
      process.env.JWT_SECRET || 'gramx_secret',
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'User created successfully',
      token,
      user: {
        id: newUser._id,
        username: newUser.username,
        email: newUser.email,
        phone: newUser.phone,
        profilePhotoUrl: newUser.profilePhotoUrl,
        about: newUser.about
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, phone, password } = req.body;
    
    if (!password || (!email && !phone)) {
      return res.status(400).json({ error: 'Missing credentials' });
    }

    // Find user
    const user = await User.findOne({
      $or: [{ email }, { phone }]
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'gramx_secret',
      { expiresIn: '7d' }
    );

    // Update last seen
    user.lastSeen = new Date();
    await user.save();

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        phone: user.phone,
        profilePhotoUrl: user.profilePhotoUrl,
        about: user.about,
        settings: user.settings
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/user/:id', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-passwordHash');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const { username, about, profilePhotoUrl } = req.body;
    const user = await User.findById(req.user._id);
    
    if (username) user.username = username;
    if (about) user.about = about;
    if (profilePhotoUrl) user.profilePhotoUrl = profilePhotoUrl;
    
    await user.save();
    
    res.json({
      message: 'Profile updated successfully',
      user: {
        id: user._id,
        username: user.username,
        profilePhotoUrl: user.profilePhotoUrl,
        about: user.about
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/messages/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user._id;
    
    const messages = await Message.find({
      $or: [
        { senderId: currentUserId, receiverId: userId },
        { senderId: userId, receiverId: currentUserId }
      ]
    })
    .sort({ timestamp: 1 })
    .populate('senderId', 'username profilePhotoUrl')
    .populate('receiverId', 'username profilePhotoUrl');
    
    res.json(messages);
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/upload', authenticateToken, async (req, res) => {
  try {
    if (!req.body.file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    
    // Upload to Cloudinary (in a real app, you'd handle file uploads properly)
    const uploadResponse = await cloudinary.uploader.upload(req.body.file, {
      folder: 'gramx',
      resource_type: 'auto'
    });
    
    res.json({ url: uploadResponse.secure_url });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'File upload failed' });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  // Join user's room
  socket.on('join', (userId) => {
    socket.join(userId);
    console.log(`User ${userId} joined room`);
  });
  
  // Handle sending messages
  socket.on('sendMessage', async (data) => {
    try {
      const { senderId, receiverId, message, type, mediaUrl, disappearing } = data;
      
      // Create new message
      const newMessage = new Message({
        chatId: `${senderId}-${receiverId}`,
        senderId,
        receiverId,
        type: type || 'text',
        message,
        mediaUrl: mediaUrl || '',
        status: 'sent',
        disappearing: disappearing || { isActive: false, duration: 0 }
      });
      
      await newMessage.save();
      
      // Populate sender info
      await newMessage.populate('senderId', 'username profilePhotoUrl');
      await newMessage.populate('receiverId', 'username profilePhotoUrl');
      
      // Emit to sender
      socket.emit('messageSent', newMessage);
      
      // Emit to receiver
      socket.to(receiverId).emit('newMessage', newMessage);
      
      // Update chat last message
      const chat = await Chat.findOne({
        participants: { $all: [senderId, receiverId] }
      });
      
      if (chat) {
        chat.lastMessageId = newMessage._id;
        chat.updatedAt = new Date();
        await chat.save();
      } else {
        const newChat = new Chat({
          type: 'private',
          participants: [senderId, receiverId],
          lastMessageId: newMessage._id
        });
        await newChat.save();
      }
    } catch (error) {
      console.error('Send message error:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });
  
  // Handle message status updates
  socket.on('messageStatus', async (data) => {
    try {
      const { messageId, status } = data;
      
      const message = await Message.findByIdAndUpdate(
        messageId,
        { status },
        { new: true }
      ).populate('senderId', 'username profilePhotoUrl');
      
      if (message) {
        // Notify sender about status update
        socket.to(message.senderId._id.toString()).emit('messageStatusUpdate', {
          messageId,
          status
        });
      }
    } catch (error) {
      console.error('Message status error:', error);
    }
  });
  
  // Handle message reactions
  socket.on('messageReaction', async (data) => {
    try {
      const { messageId, userId, emoji } = data;
      
      const message = await Message.findById(messageId);
      if (!message) return;
      
      // Remove existing reaction from this user
      message.reactions = message.reactions.filter(
        reaction => reaction.userId.toString() !== userId
      );
      
      // Add new reaction if emoji is provided
      if (emoji) {
        message.reactions.push({ userId, emoji });
      }
      
      await message.save();
      
      // Notify both users about the reaction
      socket.emit('messageReactionUpdate', {
        messageId,
        reactions: message.reactions
      });
      
      socket.to(message.senderId.toString()).emit('messageReactionUpdate', {
        messageId,
        reactions: message.reactions
      });
      
      if (message.senderId.toString() !== message.receiverId.toString()) {
        socket.to(message.receiverId.toString()).emit('messageReactionUpdate', {
          messageId,
          reactions: message.reactions
        });
      }
    } catch (error) {
      console.error('Message reaction error:', error);
    }
  });
  
  // Handle typing indicators
  socket.on('typing', (data) => {
    const { userId, receiverId, isTyping } = data;
    socket.to(receiverId).emit('typing', { userId, isTyping });
  });
  
  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
