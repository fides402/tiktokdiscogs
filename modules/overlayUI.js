import { youtubeService } from './youtubeService.js';

export const overlayUI = {
  createOverlay(album) {
    const overlay = document.createElement('div');
    overlay.className = 'card-overlay';

    // Format link destinations
    let playlistBtnClass = 'action-btn yt-btn';
    let playlistBtnText = '▶ PLAYLIST';
    let playlistBtnHref = '#';
    let playlistTarget = '';

    if (album.youtubePlaylistId || (album.youtubeVideoIds && album.youtubeVideoIds.length > 0)) {
      // Check for Android intent
      const isAndroid = navigator.userAgent.includes("Android");
      if (isAndroid) {
        playlistBtnHref = youtubeService.buildPlaylistIntentUrl(album.youtubePlaylistId, album.youtubeVideoIds);
      } else {
        playlistBtnHref = youtubeService.buildPlaylistWebUrl(album.youtubePlaylistId, album.youtubeVideoIds);
        playlistTarget = '_blank';
      }
    } else {
      playlistBtnClass += ' disabled';
      playlistBtnText = 'NO PLAYLIST';
    }

    const categoryName = album.category ? album.category.toUpperCase() : 'UNKNOWN';

    overlay.innerHTML = `
      <div class="overlay-top">
        <span class="category-badge">${categoryName}</span>
        <span class="artist-name">${album.artist}</span>
        <span class="album-title">${album.title}</span>
        <span class="album-year">${album.year}</span>
      </div>
      <div class="overlay-bottom">
        <a href="${album.discogsUrl}" target="_blank" class="action-btn">
          🔴 DISCOGS
        </a>
        <a href="${playlistBtnHref}" ${playlistTarget ? `target="${playlistTarget}"` : ''} class="${playlistBtnClass}">
          ${playlistBtnText}
        </a>
      </div>
    `;

    return overlay;
  }
};
