const fs = require('fs');
const path = require('path');
const https = require('https');

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const MODELS = {
  tiny: 'ggml-tiny.en.bin',
  small: 'ggml-small.en.bin',
  medium: 'ggml-medium.en.bin',
  large: 'ggml-large-v3.bin',
};

function getModelUrl(size) {
  const name = MODELS[size] || MODELS.tiny;
  return `${HF_BASE}/${name}`;
}

function downloadLocalModel(app, dashboardWindow, store, size) {
  const modelsDir = path.join(app.getPath('userData'), 'models');
  try {
    fs.mkdirSync(modelsDir, { recursive: true });
  } catch (_) {}
  const filename = MODELS[size] || MODELS.tiny;
  const destPath = path.join(modelsDir, filename);

  return new Promise((resolve, reject) => {
    const url = getModelUrl(size);
    const request = https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        const redirect = response.headers.location;
        if (redirect) {
          https.get(redirect, handleResponse).on('error', reject);
          return;
        }
      }
      handleResponse(response);
    });
    request.on('error', reject);

    function handleResponse(response) {
      const total = parseInt(response.headers['content-length'] || '0', 10);
      let received = 0;
      const file = fs.createWriteStream(destPath);
      response.pipe(file);
      response.on('data', (chunk) => {
        received += chunk.length;
        if (dashboardWindow && dashboardWindow.webContents) {
          dashboardWindow.webContents.send('model-download-progress', { loaded: received, total: total || 0 });
        }
      });
      file.on('finish', () => {
        file.close();
        if (dashboardWindow && dashboardWindow.webContents) {
          dashboardWindow.webContents.send('download-complete', { path: destPath, size });
        }
        resolve(destPath);
      });
      file.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }
  });
}

module.exports = { downloadLocalModel };
