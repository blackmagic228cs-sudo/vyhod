'use strict';

/*
 * Service worker проверки «Перед выходом».
 * Кешируются только файлы этого же origin. Никаких сторонних запросов.
 *
 * Стратегия: сеть → кеш. Онлайн всегда отдаётся свежая версия,
 * офлайн — последняя сохранённая. При изменении файлов всё равно
 * рекомендуется увеличить CACHE_VERSION, чтобы полностью обновить кеш.
 */

const CACHE_VERSION = 'v1.0.7';
const CACHE_NAME = `vyhod-${CACHE_VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './robots.txt',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

const INDEX_URL = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(ASSETS);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('vyhod-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

async function fetchAndCache(request) {
  const response = await fetch(request);
  if (response && response.ok && response.type === 'basic') {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetchAndCache(request);
    if (response && response.ok) return response;
    const cached = await caches.match(request);
    return cached || response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw new Error('Offline and no cache');
  }
}

async function navigationResponse(request) {
  try {
    const response = await fetchAndCache(request);
    if (response && response.ok) return response;
    const cached = (await caches.match(request)) || (await caches.match(INDEX_URL));
    return cached || response;
  } catch {
    const cached = (await caches.match(request)) || (await caches.match(INDEX_URL));
    return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request));
    return;
  }

  event.respondWith(
    networkFirst(request).catch(
      () => new Response('', { status: 504, statusText: 'Offline' }),
    ),
  );
});
