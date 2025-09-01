const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// API endpoints for different services

// Movies API proxy
app.get('/api/movies/search', async (req, res) => {
  try {
    const { query } = req.query;
    const response = await axios.get(`https://apis.davidcyriltech.my.id/movies/search?query=${query}`);
    res.json(response.data);
  } catch (error) {
    console.error('Movies API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch movies' });
  }
});

app.get('/api/movies/zoom', async (req, res) => {
  try {
    const { url } = req.query;
    const response = await axios.get(`https://apis.davidcyriltech.my.id/zoom/movie?url=${url}`);
    res.json(response.data);
  } catch (error) {
    console.error('Movie details API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch movie details' });
  }
});

// Music API proxy
app.get('/api/music/youtube', async (req, res) => {
  try {
    const { url } = req.query;
    const response = await axios.get(`https://apis.davidcyriltech.my.id/youtube/mp3?url=${url}`);
    res.json(response.data);
  } catch (error) {
    console.error('YouTube Music API error:', error.message);
    res.status(500).json({ error: 'Failed to process music request' });
  }
});

app.get('/api/music/spotify', async (req, res) => {
  try {
    const { text } = req.query;
    const response = await axios.get(`https://apis.davidcyriltech.my.id/search/spotify?text=${text}`);
    res.json(response.data);
  } catch (error) {
    console.error('Spotify API error:', error.message);
    res.status(500).json({ error: 'Failed to search Spotify' });
  }
});

// YouTube API proxy
app.get('/api/youtube/mp4', async (req, res) => {
  try {
    const { url } = req.query;
    const response = await axios.get(`https://apis.davidcyriltech.my.id/youtube/mp4?url=${url}`);
    res.json(response.data);
  } catch (error) {
    console.error('YouTube MP4 API error:', error.message);
    res.status(500).json({ error: 'Failed to process YouTube video' });
  }
});

app.get('/api/youtube/search', async (req, res) => {
  try {
    const { query } = req.query;
    const response = await axios.get(`https://apis.davidcyriltech.my.id/youtube/search?query=${query}`);
    res.json(response.data);
  } catch (error) {
    console.error('YouTube Search API error:', error.message);
    res.status(500).json({ error: 'Failed to search YouTube' });
  }
});

// TikTok API proxy
app.get('/api/tiktok/download', async (req, res) => {
  try {
    const { url } = req.query;
    const response = await axios.get(`https://apis.davidcyriltech.my.id/download/tiktokv3?url=${url}`);
    res.json(response.data);
  } catch (error) {
    console.error('TikTok API error:', error.message);
    res.status(500).json({ error: 'Failed to process TikTok video' });
  }
});

// AI Assistant API proxy
app.post('/api/ai/deepseek', async (req, res) => {
  try {
    const { text } = req.body;
    const response = await axios.post(`https://apis.davidcyriltech.my.id/ai/deepseek-v3`, { text });
    res.json(response.data);
  } catch (error) {
    console.error('AI API error:', error.message);
    res.status(500).json({ error: 'Failed to get AI response' });
  }
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`BeraStream server running on port ${PORT}`);
});
