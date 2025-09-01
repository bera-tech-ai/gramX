// API endpoints
const API_ENDPOINTS = {
    movies: {
        search: '/api/movies/search?query=',
        zoom: '/api/movies/zoom?url='
    },
    music: {
        youtube: '/api/music/youtube?url=',
        spotify: '/api/music/spotify?text='
    },
    youtube: {
        mp4: '/api/youtube/mp4?url=',
        search: '/api/youtube/search?query='
    },
    tiktok: {
        download: '/api/tiktok/download?url='
    },
    ai: {
        deepseek: '/api/ai/deepseek'
    }
};

// Current state
let currentState = {
    movieCategory: 'action',
    musicGenre: 'afrobeat',
    aiChatOpen: false
};

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    // Load initial content
    loadMovies('action');
    loadMusic('afrobeat');
    loadYouTubeVideos('trending');
    loadTikTokVideos('trending');
    
    // Set up event listeners
    setupEventListeners();
    
    // Header scroll effect
    window.addEventListener('scroll', function() {
        const header = document.querySelector('header');
        if (window.scrollY > 50) {
            header.style.boxShadow = '0 5px 15px rgba(0, 0, 0, 0.1)';
            header.style.background = 'rgba(15, 15, 19, 0.98)';
        } else {
            header.style.boxShadow = 'none';
            header.style.background = 'rgba(15, 15, 19, 0.95)';
        }
    });
});

// Set up event listeners
function setupEventListeners() {
    // Category tabs functionality
    const categoryTabs = document.querySelectorAll('.category-tab');
    categoryTabs.forEach(tab => {
        tab.addEventListener('click', function() {
            const category = this.getAttribute('data-category');
            const genre = this.getAttribute('data-genre');
            
            categoryTabs.forEach(t => t.classList.remove('active'));
            this.classList.add('active');
            
            if (category) {
                currentState.movieCategory = category;
                loadMovies(category);
            }
            
            if (genre) {
                currentState.musicGenre = genre;
                loadMusic(genre);
            }
        });
    });
    
    // Search functionality
    document.getElementById('search-input').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            const query = this.value.trim();
            if (query) {
                searchAllContent(query);
                this.value = '';
            }
        }
    });
    
    // AI Assistant functionality
    document.getElementById('ai-assistant').addEventListener('click', toggleAIChat);
    document.getElementById('close-chat').addEventListener('click', toggleAIChat);
    document.getElementById('send-message').addEventListener('click', sendAIMessage);
    document.getElementById('chat-input').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            sendAIMessage();
        }
    });
    
    // VIP button action
    document.querySelector('.vip-button').addEventListener('click', function() {
        alert('Redirecting to VIP subscription page...');
    });
    
    // Upgrade button action
    document.querySelector('.upgrade-button').addEventListener('click', function() {
        alert('Redirecting to VIP upgrade page...');
    });
    
    // Watch Now button action
    document.querySelector('.watch-now').addEventListener('click', function() {
        alert('Starting featured content...');
    });
}

// Load movies from API
async function loadMovies(category) {
    try {
        const moviesGrid = document.getElementById('movies-grid');
        moviesGrid.innerHTML = '<div class="loading"><div class="loading-dot"></div><div class="loading-dot"></div><div class="loading-dot"></div></div>';
        
        const response = await fetch(`${API_ENDPOINTS.movies.search}${category}`);
        const data = await response.json();
        
        moviesGrid.innerHTML = '';
        
        if (data && data.results && data.results.length > 0) {
            data.results.slice(0, 6).forEach(movie => {
                const card = createMovieCard(movie);
                moviesGrid.appendChild(card);
            });
        } else {
            moviesGrid.innerHTML = '<p class="no-results">No movies found. Try a different category.</p>';
        }
    } catch (error) {
        console.error('Error loading movies:', error);
        document.getElementById('movies-grid').innerHTML = '<p class="error">Error loading movies. Please try again later.</p>';
    }
}

// Create movie card
function createMovieCard(movie) {
    const card = document.createElement('div');
    card.className = 'content-card';
    
    // Use placeholder image if no poster is available
    const imageUrl = movie.poster || 'https://images.unsplash.com/photo-1489599102910-59206b8ca314?ixlib=rb-4.0.3&auto=format&fit=crop&w=500&q=80';
    
    card.innerHTML = `
        <div class="card-badge">${movie.year || 'NEW'}</div>
        <img src="${imageUrl}" alt="${movie.title}" class="card-image">
        <div class="card-content">
            <h3 class="card-title">${movie.title}</h3>
            <div class="card-info">
                <span>${movie.year || '2023'} • ${movie.genre || 'Drama'}</span>
                <div class="rating">
                    <i class="fas fa-star"></i>
                    <span>${movie.rating || '4.5'}</span>
                </div>
            </div>
            <div class="card-actions">
                <button class="action-btn" onclick="playContent('movie', '${movie.id}')">
                    <i class="fas fa-play"></i>
                </button>
                <button class="action-btn" onclick="addToFavorites('movie', '${movie.id}')">
                    <i class="fas fa-plus"></i>
                </button>
                <button class="action-btn" onclick="downloadContent('movie', '${movie.id}')">
                    <i class="fas fa-download"></i>
                </button>
            </div>
        </div>
    `;
    
    return card;
}

// Load music from API
async function loadMusic(genre) {
    try {
        const musicGrid = document.getElementById('music-grid');
        musicGrid.innerHTML = '<div class="loading"><div class="loading-dot"></div><div class="loading-dot"></div><div class="loading-dot"></div></div>';
        
        const response = await fetch(`${API_ENDPOINTS.music.spotify}${genre}`);
        const data = await response.json();
        
        musicGrid.innerHTML = '';
        
        if (data && data.tracks && data.tracks.items && data.tracks.items.length > 0) {
            data.tracks.items.slice(0, 6).forEach(track => {
                const card = createMusicCard(track);
                musicGrid.appendChild(card);
            });
        } else {
            musicGrid.innerHTML = '<p class="no-results">No music found. Try a different genre.</p>';
        }
    } catch (error) {
        console.error('Error loading music:', error);
        document.getElementById('music-grid').innerHTML = '<p class="error">Error loading music. Please try again later.</p>';
    }
}

// Create music card
function createMusicCard(track) {
    const card = document.createElement('div');
    card.className = 'content-card';
    
    // Use placeholder image if no album art is available
    const imageUrl = track.album?.images[0]?.url || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?ixlib=rb-4.0.3&auto=format&fit=crop&w=500&q=80';
    
    card.innerHTML = `
        <div class="card-badge">HOT</div>
        <img src="${imageUrl}" alt="${track.name}" class="card-image">
        <div class="card-content">
            <h3 class="card-title">${track.name}</h3>
            <div class="card-info">
                <span>${track.artists[0]?.name || 'Unknown Artist'}</span>
                <div class="rating">
                    <i class="fas fa-headphones"></i>
                    <span>${(track.popularity / 20).toFixed(1)}</span>
                </div>
            </div>
            <div class="card-actions">
                <button class="action-btn" onclick="playContent('music', '${track.id}')">
                    <i class="fas fa-play"></i>
                </button>
                <button class="action-btn" onclick="addToFavorites('music', '${track.id}')">
                    <i class="fas fa-plus"></i>
                </button>
                <button class="action-btn" onclick="downloadContent('music', '${track.id}')">
                    <i class="fas fa-download"></i>
                </button>
            </div>
        </div>
    `;
    
    return card;
}

// Load YouTube videos from API
async function loadYouTubeVideos(query) {
    try {
        const youtubeGrid = document.getElementById('youtube-grid');
        youtubeGrid.innerHTML = '<div class="loading"><div class="loading-dot"></div><div class="loading-dot"></div><div class="loading-dot"></div></div>';
        
        const response = await fetch(`${API_ENDPOINTS.youtube.search}${query}`);
        const data = await response.json();
        
        youtubeGrid.innerHTML = '';
        
        if (data && data.items && data.items.length > 0) {
            data.items.slice(0, 6).forEach(video => {
                const card = createYouTubeCard(video);
                youtubeGrid.appendChild(card);
            });
        } else {
            youtubeGrid.innerHTML = '<p class="no-results">No videos found. Try a different search.</p>';
        }
    } catch (error) {
        console.error('Error loading YouTube videos:', error);
        document.getElementById('youtube-grid').innerHTML = '<p class="error">Error loading videos. Please try again later.</p>';
    }
}

// Create YouTube card
function createYouTubeCard(video) {
    const card = document.createElement('div');
    card.className = 'content-card';
    
    const imageUrl = video.snippet.thumbnails.medium.url || 'https://i.ytimg.com/vi/6stlCkUDG_s/maxresdefault.jpg';
    
    card.innerHTML = `
        <img src="${imageUrl}" alt="${video.snippet.title}" class="card-image">
        <div class="card-content">
            <h3 class="card-title">${video.snippet.title}</h3>
            <div class="card-info">
                <span>${video.snippet.channelTitle}</span>
                <div class="rating">
                    <i class="fas fa-eye"></i>
                    <span>${video.statistics?.viewCount ? formatCount(video.statistics.viewCount) : '100K'}</span>
                </div>
            </div>
            <div class="card-actions">
                <button class="action-btn" onclick="playContent('youtube', '${video.id.videoId}')">
                    <i class="fas fa-play"></i>
                </button>
                <button class="action-btn" onclick="addToFavorites('youtube', '${video.id.videoId}')">
                    <i class="fas fa-plus"></i>
                </button>
            </div>
        </div>
    `;
    
    return card;
}

// Load TikTok videos from API
async function loadTikTokVideos(query) {
    try {
        const tiktokGrid = document.getElementById('tiktok-grid');
        tiktokGrid.innerHTML = '<div class="loading"><div class="loading-dot"></div><div class="loading-dot"></div><div class="loading-dot"></div></div>';
        
        // For demo purposes, we'll simulate a response
        // In a real implementation, you would fetch from the TikTok API
        setTimeout(() => {
            tiktokGrid.innerHTML = '';
            
            const videos = [
                { id: 1, title: 'Dance Challenge', views: '2.5M', image: 'https://images.unsplash.com/photo-1611605698335-8b156e8e4c1a?ixlib=rb-4.0.3&auto=format&fit=crop&w=500&q=80' },
                { id: 2, title: 'Comedy Skit', views: '1.8M', image: 'https://images.unsplash.com/photo-1616469829476-8953c5655574?ixlib=rb-4.0.3&auto=format&fit=crop&w=500&q=80' },
                { id: 3, title: 'Cooking Tutorial', views: '3.1M', image: 'https://images.unsplash.com/photo-1611605698335-8b156e8e4c1a?ixlib=rb-4.0.3&auto=format&fit=crop&w=500&q=80' },
                { id: 4, title: 'Life Hacks', views: '4.2M', image: 'https://images.unsplash.com/photo-1616469829476-8953c5655574?ixlib=rb-4.0.3&auto=format&fit=crop&w=500&q=80' },
                { id: 5, title: 'Travel Vlog', views: '2.9M', image: 'https://images.unsplash.com/photo-1611605698335-8b156e8e4c1a?ixlib=rb-4.0.3&auto=format&fit=crop&w=500&q=80' },
                { id: 6, title: 'Prank Video', views: '5.3M', image: 'https://images.unsplash.com/photo-1616469829476-8953c5655574?ixlib=rb-4.0.3&auto=format&fit=crop&w=500&q=80' }
            ];
            
            videos.forEach(video => {
                const card = createTikTokCard(video);
                tiktokGrid.appendChild(card);
            });
        }, 1000);
    } catch (error) {
        console.error('Error loading TikTok videos:', error);
        document.getElementById('tiktok-grid').innerHTML = '<p class="error">Error loading videos. Please try again later.</p>';
    }
}

// Create TikTok card
function createTikTokCard(video) {
    const card = document.createElement('div');
    card.className = 'content-card';
    
    card.innerHTML = `
        <img src="${video.image}" alt="${video.title}" class="card-image">
        <div class="card-content">
            <h3 class="card-title">${video.title}</h3>
            <div class="card-info">
                <span>${video.views} views</span>
            </div>
            <div class="card-actions">
                <button class="action-btn" onclick="playContent('tiktok', '${video.id}')">
                    <i class="fas fa-play"></i>
                </button>
                <button class="action-btn" onclick="addToFavorites('tiktok', '${video.id}')">
                    <i class="fas fa-plus"></i>
                </button>
            </div>
        </div>
    `;
    
    return card;
}

// Search all content
async function searchAllContent(query) {
    loadMovies(query);
    loadMusic(query);
    loadYouTubeVideos(query);
    
    // Show a notification
    showNotification(`Searching for "${query}"`);
}

// Toggle AI chat
function toggleAIChat() {
    const chatPopup = document.getElementById('chat-popup');
    currentState.aiChatOpen = !currentState.aiChatOpen;
    
    if (currentState.aiChatOpen) {
        chatPopup.style.display = 'flex';
    } else {
        chatPopup.style.display = 'none';
    }
}

// Send AI message
async function sendAIMessage() {
    const chatInput = document.getElementById('chat-input');
    const chatMessages = document.getElementById('chat-messages');
    const message = chatInput.value.trim();
    
    if (message) {
        // Add user message
        addMessage(message, 'user');
        chatInput.value = '';
        
        try {
            // Get AI response
            const response = await fetch(API_ENDPOINTS.ai.deepseek, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ text: message })
            });
            
            const data = await response.json();
            
            // Add AI response
            addMessage(data.response || "I'm sorry, I can't process your request right now.", 'bot');
        } catch (error) {
            console.error('Error getting AI response:', error);
            addMessage("I'm having trouble connecting right now. Please try again later.", 'bot');
        }
    }
}

// Add message to chat
function addMessage(text, sender) {
    const chatMessages = document.getElementById('chat-messages');
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.textContent = text;
    
    messageDiv.appendChild(contentDiv);
    chatMessages.appendChild(messageDiv);
    
    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Play content
function playContent(type, id) {
    showNotification(`Playing ${type} content`);
    // In a real implementation, this would open a player or redirect to the content
}

// Download content
function downloadContent(type, id) {
    showNotification(`Downloading ${type} content`);
    // In a real implementation, this would initiate a download
}

// Add to favorites
function addToFavorites(type, id) {
    showNotification(`Added to favorites`);
    // In a real implementation, this would save to user's favorites
}

// Show notification
function showNotification(message) {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.innerHTML = `
        <i class="fas fa-check-circle"></i>
        <span>${message}</span>
    `;
    
    // Style the notification
    notification.style.position = 'fixed';
    notification.style.top = '100px';
    notification.style.right = '20px';
    notification.style.background = 'var(--card-bg)';
    notification.style.color = 'var(--text-primary)';
    notification.style.padding = '15px 20px';
    notification.style.borderRadius = '8px';
    notification.style.boxShadow = '0 5px 15px rgba(0, 0, 0, 0.3)';
    notification.style.zIndex = '1100';
    notification.style.display = 'flex';
    notification.style.alignItems = 'center';
    notification.style.gap = '10px';
    notification.style.transform = 'translateX(100%)';
    notification.style.transition = 'transform 0.3s ease-in-out';
    notification.style.borderLeft = '4px solid var(--accent-primary)';
    
    // Add to document
    document.body.appendChild(notification);
    
    // Show notification
    setTimeout(() => {
        notification.style.transform = 'translateX(0)';
    }, 100);
    
    // Hide after 3 seconds
    setTimeout(() => {
        notification.style.transform = 'translateX(100%)';
        setTimeout(() => {
            document.body.removeChild(notification);
        }, 300);
    }, 3000);
}

// Format count (e.g., 1000 -> 1K)
function formatCount(count) {
    if (count >= 1000000) {
        return (count / 1000000).toFixed(1) + 'M';
    } else if (count >= 1000) {
        return (count / 1000).toFixed(1) + 'K';
    }
    return count;
}
