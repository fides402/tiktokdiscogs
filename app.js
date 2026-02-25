import { categorySelector } from './modules/categorySelector.js';
import { discogsService } from './modules/discogsService.js';
import { youtubeService } from './modules/youtubeService.js';
import { feedManager } from './modules/feedManager.js';

let activeCriteria = null;
let ytApiReady = false;

function init() {
    document.addEventListener('ytApiReady', () => {
        ytApiReady = true;
    });

    const categoryScreen = document.getElementById('category-screen');
    categorySelector.init(categoryScreen);

    document.addEventListener('categoriesSelected', (e) => {
        activeCriteria = e.detail.criteria;

        document.getElementById('category-screen').classList.add('hidden');
        document.getElementById('feed-screen').classList.remove('hidden');

        const container = document.getElementById('feed-container');
        feedManager.init(container, fetchNextCardData);
    });

    const openFiltersBtn = document.getElementById('open-filters-btn');
    if (openFiltersBtn) {
        openFiltersBtn.addEventListener('click', () => {
            // Pause current video
            const currentCard = feedManager.cardBuffer[feedManager.currentIndex];
            if (currentCard && currentCard.playerInstance) {
                if (typeof currentCard.playerInstance.pauseVideo === 'function') {
                    currentCard.playerInstance.pauseVideo();
                }
            }

            // Go back to category screen
            document.getElementById('feed-screen').classList.add('hidden');
            document.getElementById('category-screen').classList.remove('hidden');

            // Optionally clean up feed container totally, so it reinstantiates clean
            const container = document.getElementById('feed-container');
            container.innerHTML = '';
            feedManager.cardBuffer = [];
            if (feedManager.observer) feedManager.observer.disconnect();
        });
    }

    document.addEventListener('videoEnded', () => {
        feedManager.navigateTo(feedManager.currentIndex + 1);
    });
}

function showError(msg) {
    const toast = document.getElementById('error-toast');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 3000);
}

async function fetchNextCardData() {
    try {
        let album = null;

        try {
            album = await discogsService.fetchRandomRelease(activeCriteria);
        } catch (e) {
            console.warn("fetchRandomRelease failed, retrying once", e);
            album = await discogsService.fetchRandomRelease(activeCriteria);
        }

        let videoId = null;
        try {
            videoId = await youtubeService.searchVideo(album.artist, album.title, album.youtubeVideoIds);
        } catch (e) {
            console.warn("YouTube search failed to find a video", e);
        }

        if (!album.youtubePlaylistId && (!album.youtubeVideoIds || album.youtubeVideoIds.length === 0)) {
            try {
                const fetchedPlaylistId = await youtubeService.searchPlaylist(album.artist, album.title);
                if (fetchedPlaylistId) {
                    album.youtubePlaylistId = fetchedPlaylistId;
                }
            } catch (e) {
                console.warn("YouTube playlist search failed", e);
            }
        }

        return { album, videoId };
    } catch (error) {
        console.error("Complete failure in fetchNextCardData", error);
        showError("Errore nel recupero dati");
        throw error;
    }
}

document.addEventListener('DOMContentLoaded', init);
