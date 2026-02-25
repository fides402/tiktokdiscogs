import { CONFIG } from '../config.js';
import { videoPlayer } from './videoPlayer.js';
import { overlayUI } from './overlayUI.js';

export const feedManager = {
    cardBuffer: [],
    currentIndex: 0,
    container: null,
    fetchCallback: null,
    observer: null,
    isNavigating: false,
    isPreloading: false,

    init(feedContainerElement, fetchCardDataCallback) {
        this.container = feedContainerElement;
        this.fetchCallback = fetchCardDataCallback;
        this.currentIndex = 0;
        this.isPreloading = false;

        // Set up intersection observer to detect current card
        this.observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
                    const index = parseInt(entry.target.dataset.index, 10);
                    this.handleCardVisible(index);
                }
            });
        }, {
            root: this.container,
            threshold: [0.5]
        });

        // Keyboard navigation
        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                this.navigateTo(this.currentIndex + 1);
            } else if (e.key === 'ArrowUp') {
                this.navigateTo(this.currentIndex - 1);
            }
        });

        // Swipe down/up handling could be handled implicitly by scroll-snap,
        // but the intersection observer catches the active element.

        // Load initial batch
        this.preloadCards(0);
    },

    async preloadCards(currentIndex) {
        if (this.isPreloading) {
            // If already preloading, just update the target index and let the existing loop handle it
            this.targetPreloadIndex = Math.max(this.targetPreloadIndex || 0, currentIndex + CONFIG.FEED_BUFFER_SIZE);
            return;
        }

        this.isPreloading = true;
        this.targetPreloadIndex = Math.max(this.targetPreloadIndex || 0, currentIndex + CONFIG.FEED_BUFFER_SIZE);

        const fetchTasks = [];

        while (this.cardBuffer.length < this.targetPreloadIndex) {
            const i = this.cardBuffer.length;

            // Initialize slot as loading
            this.cardBuffer.push({
                index: i,
                state: 'loading',
                album: null,
                videoId: null,
                domElement: null,
                playerInstance: null
            });

            // Show loading spinner immediately if it's the current active card
            if (i === this.currentIndex) {
                this.renderLoadingCard(i);
            }

            // Launch fetch task concurrently instead of awaiting sequentially
            fetchTasks.push((async (index) => {
                let success = false;
                let attempt = 0;
                while (!success) {
                    try {
                        const data = await this.fetchCallback();
                        if (data && data.videoId && data.album) {
                            success = true;
                            // Clean up loading UI if present, then render
                            if (this.cardBuffer[index].domElement) {
                                this.cardBuffer[index].domElement.remove();
                            }
                            this.renderCard(index, data.album, data.videoId);

                            // Let the system breathe to avoid API limits (Discogs limit is ~60 req/min)
                            await new Promise(resolve => setTimeout(resolve, 400));
                        } else {
                            // Data valid but no YouTube video (edge case), try again immediately
                            console.warn("Got album but no YouTube video, retrying silently...");
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    } catch (err) {
                        if (err.code === 'ZERO_RESULTS') {
                            document.dispatchEvent(new CustomEvent('zeroResults'));
                            this.isPreloading = false;
                            return; // Stop the feed preloading entirely
                        }
                        attempt++;
                        console.error(`Fetch failed for card, retrying silently (attempt ${attempt})`, err);
                        // Exponential backoff before retrying on hard error
                        const backoff = Math.min(1000 * Math.pow(1.5, attempt), 10000);
                        await new Promise(resolve => setTimeout(resolve, backoff));
                    }
                }
            })(i));

            // Stagger parallel requests very slightly to prevent hitting 429 rate limit exactly at the same millisecond
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        // Wait for all concurrent fetch tasks to finish before releasing the overall lock
        await Promise.allSettled(fetchTasks);
        this.isPreloading = false;
    },

    renderLoadingCard(index) {
        const el = document.createElement('div');
        el.className = 'feed-card loading-card';
        el.dataset.index = index;
        el.innerHTML = '<div class="loading-spinner"></div>';

        this.cardBuffer[index].domElement = el;
        this.container.appendChild(el);
    },

    renderCard(index, album, videoId) {
        const card = this.cardBuffer[index];
        card.album = album;
        card.videoId = videoId;
        card.state = 'ready';

        const el = document.createElement('div');
        el.className = 'feed-card';
        el.dataset.index = index;

        // Ensure we have a container for the player
        const ytContainer = document.createElement('div');
        ytContainer.className = 'yt-player-container';
        el.appendChild(ytContainer);

        // Add overlay details
        const overlay = overlayUI.createOverlay(album);

        // Add click listener for Play/Pause
        overlay.addEventListener('click', (e) => {
            // Don't toggle if clicking on a button
            if (e.target.closest('.action-btn')) return;

            if (card.playerInstance && typeof card.playerInstance.getPlayerState === 'function') {
                const state = card.playerInstance.getPlayerState();
                // window.YT.PlayerState.PLAYING is 1
                if (state === 1) {
                    card.playerInstance.pauseVideo();
                } else {
                    card.playerInstance.playVideo();
                }
            }
        });

        el.appendChild(overlay);

        // Add Unmute button for the first card to bypass autoplay policy
        if (index === 0) {
            const unmuteBtn = document.createElement('div');
            unmuteBtn.className = 'unmute-overlay';
            unmuteBtn.innerHTML = '<div class="unmute-btn">TAP TO UNMUTE</div>';

            unmuteBtn.addEventListener('click', () => {
                unmuteBtn.remove();
                if (card.playerInstance && card.playerInstance.unMute) {
                    card.playerInstance.unMute();
                    card.playerInstance.setVolume(100);
                }
            });
            el.appendChild(unmuteBtn);
        }

        card.domElement = el;
        this.container.appendChild(el);
        this.observer.observe(el);

        // Wait for the ytApiReady event if needed, but in our case, we might be delayed enough.
        // If not, videoPlayer handles queueing.
        card.playerInstance = videoPlayer.createPlayer(el, videoId);

        // Play immediately if this is the active index
        if (index === this.currentIndex) {
            videoPlayer.play(card.playerInstance);
        }
    },

    handleCardVisible(index) {
        if (this.currentIndex === index && !this.isNavigating) return;

        const oldCard = this.cardBuffer[this.currentIndex];
        if (oldCard && oldCard.playerInstance) {
            videoPlayer.pause(oldCard.playerInstance);
        }

        this.currentIndex = index;
        const newCard = this.cardBuffer[index];

        if (newCard && newCard.playerInstance) {
            if (typeof newCard.playerInstance.seekTo === 'function') {
                newCard.playerInstance.seekTo(0);
            }
            videoPlayer.play(newCard.playerInstance);
            // Subsequent videos can play with sound after interaction
            if (index > 0 && typeof newCard.playerInstance.unMute === 'function') {
                newCard.playerInstance.unMute();
            }
        }

        if (index + 4 >= this.cardBuffer.length) {
            this.preloadCards(this.currentIndex);
        }
    },

    navigateTo(index) {
        if (index < 0 || index >= this.cardBuffer.length) return;
        this.isNavigating = true;

        const card = this.cardBuffer[index];
        if (card && card.domElement) {
            card.domElement.scrollIntoView({ behavior: 'smooth' });
        }

        setTimeout(() => { this.isNavigating = false; }, 500);
    }
};
