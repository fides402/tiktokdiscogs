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
                if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
                    const index = parseInt(entry.target.dataset.index, 10);
                    this.handleCardVisible(index);
                }
            });
        }, {
            root: this.container,
            threshold: [0, 0.25, 0.5, 0.75, 1.0]
        });

        // Keyboard navigation
        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                this.navigateTo(this.currentIndex + 1);
            } else if (e.key === 'ArrowUp') {
                this.navigateTo(this.currentIndex - 1);
            }
        });

        // Bluetooth headphone next/prev track buttons via Media Session API
        if ('mediaSession' in navigator) {
            navigator.mediaSession.setActionHandler('nexttrack', () => {
                this.navigateTo(this.currentIndex + 1);
            });
            navigator.mediaSession.setActionHandler('previoustrack', () => {
                this.navigateTo(this.currentIndex - 1);
            });
        }

        // Swipe down/up handling could be handled implicitly by scroll-snap,
        // but the intersection observer catches the active element.

        // Load initial batch
        this.preloadCards(0);
    },

    async preloadCards(currentIndex) {
        // Find the target max threshold (currentIndex + 8)
        const targetCount = currentIndex + 8;

        if (this.cardBuffer.length >= targetCount) {
            return; // We already have enough cards initialized
        }

        // Let's create empty slots immediately up to targetCount
        const missingCardsCount = targetCount - this.cardBuffer.length;

        for (let j = 0; j < missingCardsCount; j++) {
            const i = this.cardBuffer.length;

            // Generate empty slot immediately in DOM
            this.cardBuffer.push({
                index: i,
                state: 'loading',
                album: null,
                videoId: null,
                domElement: null,
                playerInstance: null
            });

            if (i === this.currentIndex || i === this.currentIndex + 1) {
                this.renderLoadingCard(i);
            } else {
                // For slots far ahead, we can just create the object and the DOM element silently
                const el = document.createElement('div');
                el.className = 'feed-card loading-card';
                el.dataset.index = i;
                el.innerHTML = '<div class="loading-spinner"></div>';
                this.cardBuffer[i].domElement = el;
                this.container.appendChild(el);
            }

            // Asynchronously resolve this empty slot by asking the buffer
            (async (index) => {
                const data = await this.fetchCallback(); // This will point to dataBuffer.consume()
                // Guard: pipeline may have been reset while we were waiting
                if (data && data.album && this.cardBuffer[index]) {
                    if (this.cardBuffer[index].domElement) {
                        this.cardBuffer[index].domElement.remove();
                    }
                    this.renderCard(index, data.album, data.videoId);
                }
            })(i);
        }
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

        // Add overlay details (pass videoId as fallback for PLAYLIST button)
        const overlay = overlayUI.createOverlay(album, videoId);

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

        // Start creating the YT player immediately so the iframe has time to load
        // before the user scrolls to this card (cards are rendered 8 slots ahead).
        this.createPlayerIfNeeded(index);

        // Play immediately if this is the active index
        if (index === this.currentIndex) {
            this.handleCardVisible(index);
        }
    },

    async createPlayerIfNeeded(index) {
        if (index < 0 || index >= this.cardBuffer.length) return;
        const card = this.cardBuffer[index];
        if (!card || !card.domElement || card.state !== 'ready') return;

        if (!card.playerInstance) {
            const playlistId = card.album ? card.album.youtubePlaylistId : null;
            card.playerInstance = await videoPlayer.createPlayer(card.domElement, card.videoId, playlistId);
        }
    },

    destroyPlayerIfExists(index) {
        if (index < 0 || index >= this.cardBuffer.length) return;
        const card = this.cardBuffer[index];
        if (!card || !card.playerInstance) return;

        videoPlayer.destroyPlayer(card.playerInstance);
        card.playerInstance = null;

        // Ensure the iframe is actually gone and container is ready for next time
        const container = card.domElement.querySelector('.yt-player-container');
        if (container) container.innerHTML = '';
    },

    async handleCardVisible(index) {
        // Only skip if we're already on this card AND the player already exists
        // (avoids blocking initial play when currentIndex === index but player is not yet created)
        const existingCard = this.cardBuffer[index];
        if (this.currentIndex === index && !this.isNavigating && existingCard && existingCard.playerInstance) return;

        const oldCard = this.cardBuffer[this.currentIndex];
        if (oldCard && oldCard.playerInstance) {
            videoPlayer.pause(oldCard.playerInstance);
        }

        this.currentIndex = index;

        // Rolling player window: keep N-1, N, N+1, N+2 alive so videos buffer ahead of time
        this.createPlayerIfNeeded(index - 1).then(() => {
            const prevCard = this.cardBuffer[index - 1];
            if (prevCard && prevCard.playerInstance) videoPlayer.pause(prevCard.playerInstance);
        });

        this.createPlayerIfNeeded(index).then(() => {
            const newCard = this.cardBuffer[index];
            if (newCard && newCard.playerInstance) {
                // Only seek to start if the player has already been used (state !== -1 unstarted)
                const state = typeof newCard.playerInstance.getPlayerState === 'function'
                    ? newCard.playerInstance.getPlayerState()
                    : -1;
                if (state !== -1 && typeof newCard.playerInstance.seekTo === 'function') {
                    newCard.playerInstance.seekTo(0);
                }
                videoPlayer.play(newCard.playerInstance);
                // Subsequent videos can play with sound after interaction
                if (index > 0 && typeof newCard.playerInstance.unMute === 'function') {
                    newCard.playerInstance.unMute();
                }
            }
        });

        // Pre-load the next two cards so their iframes are ready when the user swipes
        this.createPlayerIfNeeded(index + 1).then(() => {
            const nextCard = this.cardBuffer[index + 1];
            if (nextCard && nextCard.playerInstance) videoPlayer.pause(nextCard.playerInstance);
        });
        this.createPlayerIfNeeded(index + 2); // silently pre-buffer, no action needed

        // Destroy players outside the window (keep N-1 … N+2, destroy N-2 and N+3)
        this.destroyPlayerIfExists(index - 2);
        this.destroyPlayerIfExists(index + 3);

        // Trigger preload to guarantee N+8
        this.preloadCards(this.currentIndex);
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
