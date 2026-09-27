'use strict';

// Set the saved appearance before the stylesheet and first paint, not after IPC.
document.documentElement.dataset.theme = window.ptz.initialTheme === 'light' ? 'light' : 'dark';
