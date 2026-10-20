
        const $ = (id) => document.getElementById(id);
        const cssEsc = (v) => (window.CSS && CSS.escape) ? CSS.escape(String(v)) : String(v).replace(/"/g, '\\"');

        const AVATAR_COLORS = { default1: '#3B82F6', default2: '#F97316', default3: '#10B981', default4: '#8B5CF6', default5: '#EAB308', default6: '#EC4899' };
        const GROUP_COLORS = ['#3B82F6', '#F97316', '#10B981', '#8B5CF6', '#EAB308', '#EC4899', '#06B6D4'];
        const STATUS_BACKGROUNDS = ['#1E3A8A', '#1F3A5F', '#5B2A4A', '#4A3B12', '#2A2F36', '#0F5C4A'];
        const BUBBLE_COLORS = ['#2A4FA8', '#1E3A5F', '#4A2B5C', '#5C3A1E', '#1F4A4A', '#5C1E2B'];
        const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
        const IMAGE_LIMIT = 2.9 * 1024 * 1024;
        const AUDIO_LIMIT = 3.9 * 1024 * 1024;
        const MAX_VOICE_SECONDS = 120;
        const STATUS_MS = 5000;
        const HOLD_MS = 180;
        const MSG_HOLD_MS = 420;
        const GROUP_MAX = 256;

        const state = {
            user: null, token: null, socket: null, settings: null,
            tab: 'chats', filter: 'all', showArchived: false,
            conversations: [], groups: [], statuses: [], profiles: {}, contacts: [],
            activity: new Map(),
            messageIndex: new Map(),
            starredIds: new Set(),
            viewer: emptyViewer(),
            composer: { bg: STATUS_BACKGROUNDS[0], image: null },
            pages: [], pageData: {},
            channels: [], channelView: null, channelPosts: [], postTarget: null,
            oneViewNext: false,
            suppressOpen: false, suppressTap: false,
            rowTarget: null, memberTarget: null, menuMsg: null,
            replyTo: null, editing: null, fwdMessage: null,
            hits: [], hitIndex: -1,
            chat: emptyChat(),
            voice: { recorder: null, stream: null, chunks: [], startedAt: 0, timer: null, discard: false }
        };

        function emptyViewer() {
            return { user: null, items: [], index: 0, elapsed: 0, last: 0, paused: false, held: false, holdTimer: null, timer: null, sheet: null };
        }

        function emptyChat() {
            return { kind: 'private', partner: null, groupId: null, group: null, profile: null, prefs: {}, block: { byMe: false, byThem: false }, stopTimer: null, lastSent: 0 };
        }

        // Helpers

        function esc(value) {
            return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }
        function fmtTime(date) { return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
        function fmtDay(date) {
            const d = new Date(date);
            return d.toDateString() === new Date().toDateString() ? fmtTime(date) : d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
        }
        function formatLastSeen(date) {
            const d = new Date(date), now = new Date(), yesterday = new Date(now - 86400000);
            if (d.toDateString() === now.toDateString()) return 'today at ' + fmtTime(date);
            if (d.toDateString() === yesterday.toDateString()) return 'yesterday at ' + fmtTime(date);
            return d.toLocaleDateString() + ' at ' + fmtTime(date);
        }
        function fmtDuration(seconds) { const s = Math.floor(seconds); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
        function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }
        function debounce(fn, wait) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); }; }

        function toast(message) {
            const el = $('toast');
            el.textContent = message;
            el.classList.add('show');
            clearTimeout(toast.timer);
            toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
        }

        function S() {
            const s = state.settings || {};
            return {
                theme: 'dark', notifications: true, sound: true, keepArchived: false,
                displayName: null, about: '', avatar: 'default1', customAvatar: null, customBackground: null,
                ...s,
                privacy: { lastSeen: 'everyone', profilePhoto: 'everyone', readReceipts: true, ...(s.privacy || {}) },
                blockedUsers: s.blockedUsers || [],
                mutedChats: s.mutedChats || []
            };
        }

        function selfProfile() {
            const s = S();
            return { username: state.user, displayName: s.displayName || state.user, avatar: s.avatar, customAvatar: s.customAvatar };
        }
        function profileFor(username) {
            return state.profiles[username] || { username, displayName: username, avatar: 'default1', customAvatar: null };
        }
        function nameOf(username) {
            if (username === state.user) return 'You';
            return profileFor(username).displayName || username;
        }
        function avatarHTML(profile, cls = 'avatar') {
            const name = profile.displayName || profile.username || '?';
            if (profile.customAvatar) return `<span class="${cls}" data-zoom="${esc(profile.customAvatar)}"><img src="${esc(profile.customAvatar)}" alt=""></span>`;
            const color = AVATAR_COLORS[profile.avatar] || AVATAR_COLORS.default1;
            return `<span class="${cls}" style="background:${color}">${esc(name.charAt(0).toUpperCase())}</span>`;
        }
        function groupColor(id) {
            let sum = 0;
            for (const ch of String(id)) sum += ch.charCodeAt(0);
            return GROUP_COLORS[sum % GROUP_COLORS.length];
        }
        function groupAvatarHTML(g, cls = 'avatar') {
            if (g.photo) return `<span class="${cls} square" data-zoom="${esc(g.photo)}"><img src="${esc(g.photo)}" alt=""></span>`;
            return `<span class="${cls} square" style="background:${groupColor(g._id)}">${esc((g.name || '?').charAt(0).toUpperCase())}</span>`;
        }
        function applyTheme(theme) {
            const dark = theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
            document.documentElement.dataset.theme = dark ? 'dark' : 'light';
        }
        function applyChatStyle() {
            const chat = $('chat');
            const prefs = state.chat.prefs || {};
            if (prefs.color) {
                chat.style.setProperty('--mine', prefs.color);
                chat.style.setProperty('--mine-text', '#FFFFFF');
            } else {
                chat.style.removeProperty('--mine');
                chat.style.removeProperty('--mine-text');
            }
            const wall = prefs.wallpaper || S().customBackground;
            $('chat-messages').style.backgroundImage = wall ? `url("${wall}")` : 'none';
        }
        function requestNotifications() {
            if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        }
        function playBeep() {
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const osc = ctx.createOscillator(), gain = ctx.createGain();
                osc.connect(gain); gain.connect(ctx.destination);
                osc.frequency.value = 880;
                gain.gain.setValueAtTime(0.08, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
                osc.start(); osc.stop(ctx.currentTime + 0.25);
            } catch (err) { /* audio unavailable */ }
        }
        function blobToDataUrl(blob) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        }

        // Image pipeline and editor

        function pickFile() {
            return new Promise((resolve) => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'image/*';
                input.onchange = () => resolve(input.files[0] || null);
                input.click();
            });
        }
        function loadSource(file) {
            return new Promise((resolve, reject) => {
                if (!file || !file.type.startsWith('image/')) return reject(new Error('Choose an image file'));
                const url = URL.createObjectURL(file);
                const img = new Image();
                img.onload = () => {
                    URL.revokeObjectURL(url);
                    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
                    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
                    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                    resolve(canvas);
                };
                img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
                img.src = url;
            });
        }
        function renderEditedLegacy(source, ed, maxDim) {
            const quarter = ed.rotation % 180 !== 0;
            const rw = quarter ? source.height : source.width;
            const rh = quarter ? source.width : source.height;
            const base = document.createElement('canvas');
            base.width = rw; base.height = rh;
            const b = base.getContext('2d');
            b.translate(rw / 2, rh / 2);
            b.rotate(ed.rotation * Math.PI / 180);
            if (ed.flip) b.scale(-1, 1);
            b.drawImage(source, -source.width / 2, -source.height / 2);
            let cx = 0, cy = 0, cw = rw, ch = rh;
            if (ed.square) { const s = Math.min(rw, rh); cx = (rw - s) / 2; cy = (rh - s) / 2; cw = s; ch = s; }
            const scale = Math.min(1, maxDim / Math.max(cw, ch));
            const out = document.createElement('canvas');
            out.width = Math.max(1, Math.round(cw * scale));
            out.height = Math.max(1, Math.round(ch * scale));
            const o = out.getContext('2d');
            o.fillStyle = '#000';
            o.fillRect(0, 0, out.width, out.height);
            o.filter = `brightness(${ed.brightness}%) contrast(${ed.contrast}%) saturate(${ed.saturation}%)`;
            o.drawImage(base, cx, cy, cw, ch, 0, 0, out.width, out.height);
            o.filter = 'none';
            return out;
        }
        // Crop editor: drag the box to move it, drag a corner to resize it, or pick a fixed ratio.

        const CROP_RATIOS = [['Free', null], ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9]];

        function clamp01(v, lo = 0, hi = 1) { return Math.min(hi, Math.max(lo, v)); }

        function ratioFor(label) {
            const found = CROP_RATIOS.find(r => r[0] === label);
            return found ? found[1] : null;
        }

        // Rotates, flips, and adjusts the whole photo (no crop yet)
        function renderBase(source, ed, maxDim) {
            const quarter = ed.rotation % 180 !== 0;
            const rw = quarter ? source.height : source.width;
            const rh = quarter ? source.width : source.height;
            const scale = Math.min(1, maxDim / Math.max(rw, rh));
            const out = document.createElement('canvas');
            out.width = Math.max(1, Math.round(rw * scale));
            out.height = Math.max(1, Math.round(rh * scale));
            const o = out.getContext('2d');
            o.filter = `brightness(${ed.brightness}%) contrast(${ed.contrast}%) saturate(${ed.saturation}%)`;
            o.translate(out.width / 2, out.height / 2);
            o.rotate(ed.rotation * Math.PI / 180);
            if (ed.flip) o.scale(-1, 1);
            const dw = source.width * scale, dh = source.height * scale;
            o.drawImage(source, -dw / 2, -dh / 2, dw, dh);
            return out;
        }

        // Cuts the chosen area out of a rotated base image
        function renderCropped(base, c) {
            const sx = Math.round(c.x * base.width), sy = Math.round(c.y * base.height);
            const sw = Math.max(1, Math.round(c.w * base.width)), sh = Math.max(1, Math.round(c.h * base.height));
            const out = document.createElement('canvas');
            out.width = sw;
            out.height = sh;
            out.getContext('2d').drawImage(base, sx, sy, sw, sh, 0, 0, sw, sh);
            return out;
        }

        // Moves one corner, keeping the opposite corner fixed and the ratio if one is set
        function resizeCrop(start, corner, px, py, dims, ratio) {
            const ax = corner.includes('w') ? start.x + start.w : start.x;
            const ay = corner.startsWith('n') ? start.y + start.h : start.y;
            const toLeft = px < ax, toTop = py < ay;
            const maxW = toLeft ? ax : 1 - ax;
            const maxH = toTop ? ay : 1 - ay;
            let w = Math.max(0.04, Math.abs(px - ax));
            let h = Math.max(0.04, Math.abs(py - ay));

            if (ratio) {
                // width/height in normalised units that gives the chosen pixel ratio
                const need = ratio * dims.h / dims.w;
                h = w / need;
                if (w > maxW) { w = maxW; h = w / need; }
                if (h > maxH) { h = maxH; w = h * need; }
            } else {
                w = Math.min(w, maxW);
                h = Math.min(h, maxH);
            }
            const x = toLeft ? ax - w : ax;
            const y = toTop ? ay - h : ay;
            return { x: clamp01(x, 0, 1 - w), y: clamp01(y, 0, 1 - h), w, h };
        }

        // Makes the current crop match a ratio, staying centred on the same spot
        function fitCropToRatio(crop, ratio, dims) {
            const need = ratio * dims.h / dims.w;
            let w = crop.w, h = crop.h;
            if (w / h > need) w = h * need; else h = w / need;
            if (w > 1) { w = 1; h = w / need; }
            if (h > 1) { h = 1; w = h * need; }
            const cx = crop.x + crop.w / 2, cy = crop.y + crop.h / 2;
            return { x: clamp01(cx - w / 2, 0, 1 - w), y: clamp01(cy - h / 2, 0, 1 - h), w, h };
        }

        function openEditor(file, opts = {}) {
            return new Promise(async (resolve) => {
                let source;
                try { source = await loadSource(file); } catch (err) { toast(err.message); return resolve(null); }

                const defaultRatio = opts.square ? '1:1' : 'Free';
                const ed = {
                    rotation: 0, flip: false, brightness: 100, contrast: 100, saturation: 100,
                    crop: { x: 0, y: 0, w: 1, h: 1 },
                    ratio: defaultRatio
                };
                const outMax = opts.outMax || 1280;
                const limit = opts.limit || IMAGE_LIMIT;
                const el = $('editor');

                el.innerHTML = `
                    <header class="page-head">
                        <button class="icon-btn" data-ed="cancel" aria-label="Cancel"><i class="fa-solid fa-xmark"></i></button>
                        <div class="page-title">Crop and edit</div>
                        <button class="btn primary small" data-ed="done">Done</button>
                    </header>
                    <div class="editor-stage" data-stage></div>
                    <div class="editor-tools">
                        <div class="tool-row">
                            <button class="tool" data-ed="rotate"><i class="fa-solid fa-rotate-right"></i><span>Rotate</span></button>
                            <button class="tool" data-ed="flip"><i class="fa-solid fa-arrows-left-right"></i><span>Flip</span></button>
                            <button class="tool" data-ed="reset"><i class="fa-solid fa-arrow-rotate-left"></i><span>Reset</span></button>
                        </div>
                        <div class="ratio-row">${CROP_RATIOS.map(([label]) => `<button class="chip" data-ratio="${label}">${label}</button>`).join('')}</div>
                        <label class="slider"><span>Brightness</span><input type="range" min="50" max="150" value="100" data-adj="brightness"></label>
                        <label class="slider"><span>Contrast</span><input type="range" min="50" max="150" value="100" data-adj="contrast"></label>
                        <label class="slider"><span>Saturation</span><input type="range" min="0" max="200" value="100" data-adj="saturation"></label>
                    </div>`;
                el.hidden = false;

                const stage = el.querySelector('[data-stage]');
                let dims = { w: 1, h: 1 };
                let wrap = null, box = null;

                function placeBox() {
                    box.style.left = (ed.crop.x * 100) + '%';
                    box.style.top = (ed.crop.y * 100) + '%';
                    box.style.width = (ed.crop.w * 100) + '%';
                    box.style.height = (ed.crop.h * 100) + '%';
                }

                function markRatio() {
                    el.querySelectorAll('[data-ratio]').forEach(b => b.classList.toggle('active', b.dataset.ratio === ed.ratio));
                }

                function layout() {
                    const base = renderBase(source, ed, 1000);
                    dims = { w: base.width, h: base.height };
                    const maxW = Math.max(120, stage.clientWidth - 32);
                    const maxH = Math.max(120, stage.clientHeight - 32);
                    const s = Math.min(maxW / base.width, maxH / base.height);
                    wrap = document.createElement('div');
                    wrap.className = 'crop-wrap';
                    wrap.style.width = Math.floor(base.width * s) + 'px';
                    wrap.style.height = Math.floor(base.height * s) + 'px';
                    base.style.width = '100%';
                    base.style.height = '100%';
                    base.style.display = 'block';
                    wrap.appendChild(base);
                    box = document.createElement('div');
                    box.className = 'crop-box';
                    box.innerHTML = ['nw', 'ne', 'sw', 'se'].map(h => `<span class="crop-h" data-h="${h}"></span>`).join('');
                    wrap.appendChild(box);
                    stage.replaceChildren(wrap);
                    placeBox();
                    markRatio();
                }

                let drag = null;
                stage.addEventListener('pointerdown', (e) => {
                    const inBox = e.target.closest('.crop-box');
                    if (!inBox || !wrap) return;
                    e.preventDefault();
                    const handle = e.target.closest('.crop-h');
                    drag = {
                        mode: handle ? 'resize' : 'move',
                        corner: handle ? handle.dataset.h : null,
                        start: { ...ed.crop },
                        sx: e.clientX, sy: e.clientY,
                        rect: wrap.getBoundingClientRect()
                    };
                    stage.setPointerCapture(e.pointerId);
                });
                stage.addEventListener('pointermove', (e) => {
                    if (!drag) return;
                    const r = drag.rect;
                    if (drag.mode === 'move') {
                        const dx = (e.clientX - drag.sx) / r.width;
                        const dy = (e.clientY - drag.sy) / r.height;
                        const c = drag.start;
                        ed.crop = { x: clamp01(c.x + dx, 0, 1 - c.w), y: clamp01(c.y + dy, 0, 1 - c.h), w: c.w, h: c.h };
                    } else {
                        const px = clamp01((e.clientX - r.left) / r.width);
                        const py = clamp01((e.clientY - r.top) / r.height);
                        ed.crop = resizeCrop(drag.start, drag.corner, px, py, dims, ratioFor(ed.ratio));
                    }
                    placeBox();
                });
                const endDrag = () => { drag = null; };
                stage.addEventListener('pointerup', endDrag);
                stage.addEventListener('pointercancel', endDrag);

                el.onclick = (e) => {
                    const ratioBtn = e.target.closest('[data-ratio]');
                    if (ratioBtn) {
                        ed.ratio = ratioBtn.dataset.ratio;
                        const r = ratioFor(ed.ratio);
                        if (r) ed.crop = fitCropToRatio(ed.crop, r, dims);
                        if (wrap) placeBox();
                        markRatio();
                        return;
                    }
                    const btn = e.target.closest('[data-ed]');
                    if (!btn) return;
                    switch (btn.dataset.ed) {
                        case 'cancel':
                            el.hidden = true;
                            el.innerHTML = '';
                            el.onclick = null;
                            return resolve(null);
                        case 'done': {
                            const out = exportJpeg(renderCropped(renderBase(source, ed, outMax), ed.crop), limit);
                            if (!out) return toast('That photo is too large, even after compression');
                            el.hidden = true;
                            el.innerHTML = '';
                            el.onclick = null;
                            return resolve(out);
                        }
                        case 'rotate':
                            ed.rotation = (ed.rotation + 90) % 360;
                            ed.crop = { x: 0, y: 0, w: 1, h: 1 };
                            return layout();
                        case 'flip':
                            ed.flip = !ed.flip;
                            return layout();
                        case 'reset':
                            Object.assign(ed, { rotation: 0, flip: false, brightness: 100, contrast: 100, saturation: 100, crop: { x: 0, y: 0, w: 1, h: 1 }, ratio: defaultRatio });
                            el.querySelectorAll('input[data-adj]').forEach(i => { i.value = 100; });
                            return layout();
                    }
                };

                el.querySelectorAll('input[data-adj]').forEach(input => {
                    input.oninput = () => { ed[input.dataset.adj] = Number(input.value); layout(); };
                });

                layout();
            });
        }

        function exportJpeg(canvas, limit) {
            for (const quality of [0.88, 0.78, 0.66, 0.54, 0.42]) {
                const data = canvas.toDataURL('image/jpeg', quality);
                if (data.length <= limit) return data;
            }
            return null;
        }
        function openEditorLegacy(file, opts = {}) {
            return new Promise(async (resolve) => {
                let source;
                try { source = await loadSource(file); } catch (err) { toast(err.message); return resolve(null); }

                const defaults = { rotation: 0, flip: false, square: !!opts.square, brightness: 100, contrast: 100, saturation: 100 };
                const ed = { ...defaults };
                const outMax = opts.outMax || 1280;
                const limit = opts.limit || IMAGE_LIMIT;
                const el = $('editor');

                el.innerHTML = `
                    <header class="page-head">
                        <button class="icon-btn" data-ed="cancel" aria-label="Cancel"><i class="fa-solid fa-xmark"></i></button>
                        <div class="page-title">Edit photo</div>
                        <button class="btn primary small" data-ed="done">Done</button>
                    </header>
                    <div class="editor-stage" data-stage></div>
                    <div class="editor-tools">
                        <div class="tool-row">
                            <button class="tool" data-ed="rotate"><i class="fa-solid fa-rotate-right"></i><span>Rotate</span></button>
                            <button class="tool" data-ed="flip"><i class="fa-solid fa-arrows-left-right"></i><span>Flip</span></button>
                            <button class="tool" data-ed="square" data-square><i class="fa-solid fa-crop"></i><span>Crop</span></button>
                            <button class="tool" data-ed="reset"><i class="fa-solid fa-arrow-rotate-left"></i><span>Reset</span></button>
                        </div>
                        <label class="slider"><span>Brightness</span><input type="range" min="50" max="150" value="100" data-adj="brightness"></label>
                        <label class="slider"><span>Contrast</span><input type="range" min="50" max="150" value="100" data-adj="contrast"></label>
                        <label class="slider"><span>Saturation</span><input type="range" min="0" max="200" value="100" data-adj="saturation"></label>
                    </div>`;
                el.hidden = false;
                const stage = el.querySelector('[data-stage]');
                const draw = () => {
                    const preview = renderEdited(source, ed, 900);
                    preview.className = 'editor-canvas';
                    stage.replaceChildren(preview);
                    el.querySelector('[data-square]').classList.toggle('on', ed.square);
                };
                const close = (result) => { el.hidden = true; el.innerHTML = ''; el.onclick = null; resolve(result); };

                el.onclick = (e) => {
                    const btn = e.target.closest('[data-ed]');
                    if (!btn) return;
                    switch (btn.dataset.ed) {
                        case 'cancel': return close(null);
                        case 'done': {
                            const out = exportJpeg(renderEdited(source, ed, outMax), limit);
                            if (!out) return toast('That photo is too large, even after compression');
                            return close(out);
                        }
                        case 'rotate': ed.rotation = (ed.rotation + 90) % 360; break;
                        case 'flip': ed.flip = !ed.flip; break;
                        case 'square': ed.square = !ed.square; break;
                        case 'reset':
                            Object.assign(ed, defaults);
                            el.querySelectorAll('input[data-adj]').forEach(i => { i.value = 100; });
                            break;
                    }
                    draw();
                };
                el.querySelectorAll('input[data-adj]').forEach(input => {
                    input.oninput = () => { ed[input.dataset.adj] = Number(input.value); draw(); };
                });
                draw();
            });
        }

        // API

        const api = {
            headers() { return { 'Content-Type': 'application/json', 'x-username': state.user || '', 'x-token': state.token || '' }; },
            get(path) { return fetch(path, { headers: this.headers() }).then(r => r.json()); },
            post(path, body) {
                return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
            }
        };

        // Screens and auth

        function showScreen(id) { ['splash', 'auth', 'app'].forEach(name => { $(name).hidden = name !== id; }); }
        function showAuthForm(which) {
            $('login-view').hidden = which !== 'login';
            $('register-view').hidden = which !== 'register';
            $('forgot-view').hidden = which !== 'forgot';
        }

        async function sendForgotRequest() {
            const username = $('forgot-username').value.trim();
            if (!username) { $('forgot-error').textContent = 'Enter your username'; $('forgot-error').hidden = false; return; }
            $('forgot-error').hidden = true;
            const res = await api.post('/forgot-password', { username }).catch(() => null);
            if (!res || !res.success) {
                $('forgot-error').textContent = res?.error || 'Network error. Try again.';
                $('forgot-error').hidden = false;
                return;
            }
            $('forgot-message').textContent = res.message;
            $('forgot-message').hidden = false;
        }
        function setAuthError(id, message) { const el = $(id); el.textContent = message || ''; el.hidden = !message; }

        async function login() {
            const username = $('login-username').value.trim();
            const password = $('login-password').value;
            if (!username || !password) return setAuthError('login-error', 'Enter your username and password');
            const res = await api.post('/login', { username, password }).catch(() => null);
            if (!res) return setAuthError('login-error', 'Network error. Try again.');
            if (!res.success) return setAuthError('login-error', res.error);
            setAuthError('login-error', '');
            startSession(res.username, res.token);
        }

        async function pickRegPhoto() {
            const file = await pickFile();
            if (!file) return;
            const data = await openEditor(file, { square: true, outMax: 400, limit: 600 * 1024 });
            if (!data) return;
            state.regPhoto = data;
            $('reg-photo-preview').innerHTML = `<img src="${esc(data)}" alt="">`;
            $('reg-photo-preview').style.background = 'none';
            setAuthError('register-error', '');
        }

        async function register() {
            const fullName = $('reg-name').value.trim();
            const username = $('reg-username').value.trim();
            const phone = $('reg-phone').value.trim();
            const password = $('reg-password').value;
            if (!username || !password) return setAuthError('register-error', 'Enter a username and password');
            const res = await api.post('/register', { fullName, username, phone, password, avatarPhoto: state.regPhoto || null }).catch(() => null);
            if (!res) return setAuthError('register-error', 'Network error. Try again.');
            if (!res.success) return setAuthError('register-error', res.error);
            setAuthError('register-error', '');
            showAuthForm('login');
            $('login-username').value = username;
            toast('Account created. Sign in to continue.');
        }

        function startSession(username, token) {
            state.user = username;
            state.token = token;
            localStorage.setItem('gramx_session', JSON.stringify({ username, token }));
            connectSocket();
            showScreen('app');
            showTab('chats');
            if (!localStorage.getItem('bm_install_done')) $('install-prompt').hidden = false;
        }

        async function restoreSession() {
            showScreen('splash');
            await new Promise(r => setTimeout(r, 1600));
            const saved = JSON.parse(localStorage.getItem('gramx_session') || 'null');
            if (!saved) return showScreen('auth');
            const res = await api.post('/session', saved).catch(() => null);
            if (res && res.success) return startSession(saved.username, saved.token);
            if (res) localStorage.removeItem('gramx_session');
            showScreen('auth');
        }

        function logout() {
            if (state.user && state.token) api.post('/logout', { username: state.user, token: state.token }).catch(() => {});
            localStorage.removeItem('gramx_session');
            closeChat(true);
            closeAllPages();
            closeViewer();
            $('composer-status').hidden = true;
            if (state.socket) state.socket.disconnect();
            Object.assign(state, { socket: null, user: null, token: null, settings: null, conversations: [], groups: [], statuses: [], profiles: {} });
            state.activity.clear();
            state.starredIds.clear();
            showAuthForm('login');
            showScreen('auth');
        }

        function deleteAccount() {
            if (!confirm('Delete your account permanently? This removes your chats, group membership and statuses.')) return;
            state.socket.emit('delete-account', {}, (res) => {
                if (!res || !res.success) toast(res?.error || 'Could not delete account');
            });
        }

        // Socket

        function connectSocket() {
            if (state.socket) state.socket.disconnect();
            const socket = io({ auth: { username: state.user, token: state.token } });
            state.socket = socket;

            socket.on('connect', () => {
                loadSettings();
                loadConversations();
                loadStatuses();
                loadStarredIds();
                loadChannels();
            });
            socket.on('connect_error', (err) => {
                if (err.message === 'unauthorized') {
                    toast('Your session ended. Sign in again.');
                    logout();
                }
            });
            socket.on('presence-changed', onPresence);
            socket.on('new-private-message', onIncoming);
            socket.on('message-saved', ({ tempId, message }) => applySaved(tempId, message));
            socket.on('message-delivered', ({ messageIds }) => messageIds.forEach(id => setTicks(id, 'delivered')));
            socket.on('messages-read', ({ messageIds }) => messageIds.forEach(id => setTicks(id, 'read')));
            socket.on('message-deleted', onMessageDeleted);
            socket.on('message-edited', onMessageEdited);
            socket.on('message-reaction', onMessageReaction);
            socket.on('one-view-opened', ({ messageId }) => renderOpenedBubble(messageId));
            socket.on('chat-cleared', onChatCleared);
            socket.on('activity', onActivity);
            socket.on('group-message', onGroupMessage);
            socket.on('group-message-deleted', onGroupMessageDeleted);
            socket.on('group-message-edited', onMessageEdited);
            socket.on('group-cleared', onGroupCleared);
            socket.on('channel-post', onChannelPost);
            socket.on('channel-post-deleted', onChannelPostDeleted);
            socket.on('channel-post-reaction', onChannelReaction);
            socket.on('channels-changed', onChannelsChanged);
            socket.on('channel-deleted', onChannelDeleted);
            socket.on('group-deleted', onGroupDeleted);
            socket.on('groups-changed', onGroupsChanged);
            socket.on('new-status', loadStatuses);
            socket.on('status-activity', loadStatuses);
            socket.on('profile-updated', onProfileUpdated);
            socket.on('account-deleted', () => { toast('Your account was deleted.'); logout(); });
        }

        // Settings

        function loadSettings() {
            if (!state.socket) return;
            state.socket.emit('get-user-settings', (res) => {
                if (!res || !res.success) return;
                state.settings = res.settings;
                applyTheme(S().theme);
                applyChatStyle();
                if (state.pages.length && state.pages[state.pages.length - 1] === 'settings') renderPage();
            });
        }

        function saveSettings(patch, message) {
            if (state.settings) {
                for (const key of Object.keys(patch)) {
                    if (key === 'privacy') state.settings.privacy = { ...S().privacy, ...patch.privacy };
                    else state.settings[key] = patch[key];
                }
                applyTheme(S().theme);
                applyChatStyle();
            }
            state.socket.emit('update-settings', { settings: patch }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not save');
                if (message) toast(message);
                if (state.pages.length) renderPage();
            });
        }

        function saveSettingPath(key, value) {
            const patch = {};
            if (key.startsWith('privacy.')) patch.privacy = { [key.split('.')[1]]: value };
            else patch[key] = value;
            if (key === 'notifications' && value) requestNotifications();
            saveSettings(patch);
        }

        function unblockUser(target, done) {
            state.socket.emit('unblock-user', { target }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not unblock');
                if (state.settings) state.settings.blockedUsers = S().blockedUsers.filter(u => u !== target);
                toast('Unblocked');
                if (done) done();
            });
        }

        function blockUser(target, done) {
            state.socket.emit('block-user', { target }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not block');
                if (state.settings && !S().blockedUsers.includes(target)) state.settings.blockedUsers = [...S().blockedUsers, target];
                toast('Blocked');
                if (done) done();
            });
        }

        function setPrefsFor(target, patch, message) {
            if (!target || !state.socket) return;
            state.socket.emit('set-chat-prefs', { target, ...patch }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not save');
                if (state.chat.kind === 'private' && state.chat.partner === target) {
                    const next = { ...(state.chat.prefs || {}), ...patch };
                    if (patch.archived) next.pinned = false;
                    state.chat.prefs = next;
                    applyChatStyle();
                }
                if (message) toast(message);
                if (state.pages.length) renderPage();
                loadConversations();
            });
        }

        // App header and tabs

        const TAB_TITLES = { chats: 'Chats', status: 'Status', calls: 'Calls', contacts: 'Contacts', groups: 'Groups' };

        function renderAppHead() {
            const head = $('app-head');
            let left, actions = '';
            if (state.tab === 'chats') {
                left = `<div class="brand"><span class="brand-logo">B</span><span class="brand-name">B-MESSENGER</span></div>`;
                actions = `<button class="icon-btn" data-action="toggle-search" aria-label="Search"><i class="fa-solid fa-magnifying-glass"></i></button><button class="icon-btn" data-action="open-contacts" aria-label="New chat"><i class="fa-solid fa-pen-to-square"></i></button>`;
            } else {
                left = `<span class="head-title">${TAB_TITLES[state.tab]}</span>`;
                if (state.tab === 'status') actions = '<button class="icon-btn" data-action="add-status" aria-label="New status"><i class="fa-solid fa-camera"></i></button>';
                if (state.tab === 'groups') actions = '<button class="icon-btn" data-action="new-group" aria-label="New group"><i class="fa-solid fa-plus"></i></button>';
                if (state.tab === 'contacts') actions = '<button class="icon-btn" data-action="new-group" aria-label="New group"><i class="fa-solid fa-user-group"></i></button>';
            }
            actions += `<button class="icon-btn" data-action="main-menu" aria-label="Menu"><i class="fa-solid fa-ellipsis-vertical"></i></button>`;
            head.innerHTML = `${left}<div class="head-actions">${actions}</div>`;
        }

        function showTab(name) {
            state.tab = name;
            document.querySelectorAll('.tab').forEach(el => { el.hidden = el.id !== `tab-${name}`; });
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
            renderAppHead();
            if (name === 'chats') { loadConversations(); renderChatsTab(); }
            if (name === 'status') { loadStatuses(); renderUpdates(); loadChannels(); }
            if (name === 'contacts') loadContacts();
            if (name === 'groups') { loadConversations(); renderGroupsTab(); }
        }

        function updateNavBadge() {
            const total = state.conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0)
                + state.groups.reduce((sum, g) => sum + (g.unreadCount || 0), 0);
            const badge = $('nav-badge');
            badge.textContent = total > 99 ? '99+' : total;
            badge.hidden = total === 0;
        }

        // Typing and recording indicators

        function onActivity({ groupId, from, kind, on }) {
            if (!from || from === state.user) return;
            const key = groupId ? `g:${groupId}:${from}` : `u:${from}`;
            const cur = state.activity.get(key);
            if (cur) clearTimeout(cur.timer);
            if (on) {
                state.activity.set(key, { kind, timer: setTimeout(() => { state.activity.delete(key); refreshActivityUI(); }, 5000) });
            } else {
                state.activity.delete(key);
            }
            refreshActivityUI();
        }
        function activityForUser(username) { return state.activity.get(`u:${username}`)?.kind || null; }
        function activityForGroup(groupId) {
            for (const [key, value] of state.activity) {
                if (key.startsWith(`g:${groupId}:`)) return { kind: value.kind, who: key.split(':')[2] };
            }
            return null;
        }
        function activityText(kind) { return kind === 'recording' ? 'recording audio…' : 'typing…'; }
        function refreshActivityUI() { renderChatsTab(); renderGroupsTab(); renderChatHeader(); }
        function emitActivity(kind, on) {
            const chat = state.chat;
            if (!state.socket) return;
            if (chat.kind === 'group' && chat.groupId) state.socket.emit('set-activity', { groupId: chat.groupId, kind, on });
            else if (chat.kind === 'private' && chat.partner) state.socket.emit('set-activity', { target: chat.partner, kind, on });
        }

        // Chats and groups

        const scheduleConversations = debounce(() => loadConversations(), 400);

        function loadConversations() {
            if (!state.socket) return;
            state.socket.emit('get-conversations', (res) => {
                if (!res || !res.success) return;
                state.conversations = res.conversations;
                res.conversations.forEach(c => { state.profiles[c.partner] = c.profile; });
                renderChatsTab();
                updateNavBadge();
            });
            state.socket.emit('get-groups', (res) => {
                if (!res || !res.success) return;
                state.groups = res.groups;
                renderChatsTab();
                renderGroupsTab();
                updateNavBadge();
            });
        }

        const runGlobalSearch = debounce(() => {
            const q = $('chat-search').value.trim();
            const box = $('search-results');
            if (!box) return;
            if (q.length < 2) { box.innerHTML = ''; return; }
            state.socket.emit('search-all', { q }, (res) => {
                if (!res || !res.success) return;
                box.innerHTML = res.results.length
                    ? `<div class="section-head">Messages</div>` + res.results.map(r => `
                        <button class="row" data-jump-chat="${r.groupId ? 'g:' + esc(r.groupId) : 'u:' + esc(r.chat)}">
                            <div class="row-main"><div class="row-title">${esc(r.chat)}</div><div class="row-sub">${esc(r.text)}</div></div>
                            <span class="row-time">${fmtDay(r.timestamp)}</span>
                        </button>`).join('')
                    : '<div class="empty">No messages match</div>';
            });
        }, 300);

        function renderChatsTab() {
            if (state.tab !== 'chats') return;
            const q = $('chat-search').value.trim().toLowerCase();
            const f = state.filter;

            const privateMatch = (c) => {
                const name = (c.profile.displayName || c.partner).toLowerCase();
                if (q && !name.includes(q) && !c.partner.toLowerCase().includes(q)) return false;
                if (f === 'unread' && !c.unreadCount) return false;
                if (f === 'groups') return false;
                return true;
            };
            const groupMatch = (g) => {
                if (q && !g.name.toLowerCase().includes(q)) return false;
                if (f === 'unread' && !g.unreadCount) return false;
                return true;
            };

            const archived = state.conversations.filter(c => c.archived);
            const active = state.conversations.filter(c => !c.archived && privateMatch(c));
            const pinned = active.filter(c => c.pinned).sort((a, b) => new Date(b.pinnedAt || 0) - new Date(a.pinnedAt || 0));
            const restPrivate = active.filter(c => !c.pinned);
            const groupItems = state.groups.filter(groupMatch);

            let html = '';
            if (archived.length && !q && f !== 'groups') {
                html += `
                    <button class="archived-row" data-action="toggle-archived">
                        <i class="fa-solid ${state.showArchived ? 'fa-arrow-left' : 'fa-box-archive'}"></i>
                        <span>${state.showArchived ? 'Back to chats' : 'Archived'}</span>
                        ${state.showArchived ? '' : `<span class="count">${archived.length}</span>`}
                    </button>`;
            }

            if (state.showArchived) {
                html += archived.filter(privateMatch).map(conversationRowHTML).join('');
            } else {
                html += pinned.map(conversationRowHTML).join('');
                const mixed = [
                    ...restPrivate.map(c => ({ t: c.lastMessage?.timestamp, html: conversationRowHTML(c) })),
                    ...groupItems.map(g => ({ t: g.lastMessage?.timestamp || g.createdAt, html: groupRowHTML(g) }))
                ].sort((a, b) => new Date(b.t || 0) - new Date(a.t || 0));
                html += mixed.map(x => x.html).join('');
            }

            $('conversation-list').innerHTML = html;
            $('chats-empty').hidden = html.trim() !== '' || state.conversations.length + state.groups.length > 0;
        }

        function conversationRowHTML(c) {
            const p = c.profile || { username: c.partner };
            const name = p.displayName || p.username;
            const last = c.lastMessage || {};
            const typing = activityForUser(c.partner);
            let preview;
            if (typing) preview = activityText(typing);
            else if (last.deleted) preview = 'Message deleted';
            else if (last.oneView) preview = 'Photo';
            else if (last.hasAudio) preview = 'Voice message';
            else if (last.hasImage) preview = last.text ? 'Photo: ' + last.text : 'Photo';
            else preview = last.text || '';
            if (!typing && last.sender === state.user && !last.deleted) preview = 'You: ' + preview;

            return `
                <button class="row" data-open="${esc(c.partner)}">
                    ${avatarHTML(p)}
                    <div class="row-main">
                        <div class="row-title">${esc(name)}</div>
                        <div class="row-sub ${typing ? 'activity' : ''}">${esc(preview)}</div>
                    </div>
                    <div class="row-side">
                        <span class="row-time ${c.unreadCount ? 'unread' : ''}">${last.timestamp ? fmtDay(last.timestamp) : ''}</span>
                        <span class="row-badges">
                            ${c.pinned ? '<i class="fa-solid fa-thumbtack pin-ico"></i>' : ''}
                            ${c.unreadCount ? `<span class="badge">${c.unreadCount}</span>` : (p.online ? '<span class="online-dot"></span>' : '')}
                        </span>
                    </div>
                </button>`;
        }

        function groupPreview(g) {
            const act = activityForGroup(g._id);
            if (act) return `${nameOf(act.who)} is ${activityText(act.kind)}`;
            const last = g.lastMessage;
            if (!last) return plural(g.members.length, 'member');
            if (last.system) return last.text;
            const who = last.sender === state.user ? 'You' : nameOf(last.sender);
            return `${who}: ${last.text || ''}`;
        }

        function groupRowHTML(g) {
            const act = activityForGroup(g._id);
            return `
                <button class="row" data-group="${esc(g._id)}">
                    ${groupAvatarHTML(g)}
                    <div class="row-main">
                        <div class="row-title">${esc(g.name)}<span class="group-tag">Group</span></div>
                        <div class="row-sub ${act ? 'activity' : ''}">${esc(groupPreview(g))}</div>
                    </div>
                    <div class="row-side">
                        <span class="row-time ${g.unreadCount ? 'unread' : ''}">${g.lastMessage ? fmtDay(g.lastMessage.timestamp) : ''}</span>
                        ${g.unreadCount ? `<span class="badge">${g.unreadCount}</span>` : ''}
                    </div>
                </button>`;
        }

        function renderGroupsTab() {
            if (state.tab !== 'groups') return;
            const list = [...state.groups].sort((a, b) => new Date(b.lastMessage?.timestamp || b.createdAt) - new Date(a.lastMessage?.timestamp || a.createdAt));
            $('group-list').innerHTML = list.map(groupRowHTML).join('');
            $('group-empty').hidden = list.length > 0;
        }

        function personRowHTML(p) {
            return `
                <button class="row" data-open="${esc(p.username)}">
                    ${avatarHTML(p)}
                    <div class="row-main">
                        <div class="row-title">${esc(p.displayName || p.username)}</div>
                        <div class="row-sub">${esc(p.about || '@' + p.username)}</div>
                    </div>
                    ${p.online ? '<span class="online-dot"></span>' : ''}
                </button>`;
        }

        // Contacts

        function loadContacts() {
            api.get('/users').then(res => {
                if (!res || !res.success) return;
                state.contacts = res.users;
                res.users.forEach(p => { state.profiles[p.username] = p; });
                renderContacts();
            }).catch(() => {});
        }

        function renderContacts() {
            if (state.tab !== 'contacts') return;
            const q = $('contact-search').value.trim().toLowerCase();
            const onlineOnly = $('online-toggle').classList.contains('on');
            const list = state.contacts.filter(p => {
                if (onlineOnly && !p.online) return false;
                if (!q) return true;
                return p.username.toLowerCase().includes(q) || (p.displayName || '').toLowerCase().includes(q);
            });
            $('contact-list').innerHTML = list.map(personRowHTML).join('');
            $('contact-empty').hidden = list.length > 0;
        }

        let peopleTimer = null;
        function onContactSearch() {
            renderContacts();
            clearTimeout(peopleTimer);
            const q = $('contact-search').value.trim();
            if (!q) return;
            peopleTimer = setTimeout(async () => {
                const res = await api.get(`/search-users?q=${encodeURIComponent(q)}`).catch(() => null);
                if (!res || !res.success) return;
                res.users.forEach(p => { state.profiles[p.username] = p; });
                $('contact-list').innerHTML = res.users.map(personRowHTML).join('');
                $('contact-empty').hidden = res.users.length > 0;
            }, 250);
        }

        // Long press a chat row: pin or archive

        let pressTimer = null;
        function startRowPress(partner) {
            state.suppressOpen = false;
            clearTimeout(pressTimer);
            pressTimer = setTimeout(() => { state.suppressOpen = true; openRowSheet(partner); }, 500);
        }
        function cancelRowPress() { clearTimeout(pressTimer); }

        function openRowSheet(partner) {
            const conv = state.conversations.find(c => c.partner === partner);
            if (!conv) return;
            state.rowTarget = partner;
            $('row-pin').textContent = conv.pinned ? 'Unpin chat' : 'Pin chat';
            $('row-archive').textContent = conv.archived ? 'Unarchive chat' : 'Archive chat';
            $('row-sheet').hidden = false;
        }

        function runRowAction(action) {
            const target = state.rowTarget;
            $('row-sheet').hidden = true;
            const conv = state.conversations.find(c => c.partner === target);
            if (!target || !conv || action === 'close') return;
            if (action === 'pin') setPrefsFor(target, { pinned: !conv.pinned }, conv.pinned ? 'Chat unpinned' : 'Chat pinned');
            if (action === 'archive') setPrefsFor(target, { archived: !conv.archived }, conv.archived ? 'Chat unarchived' : 'Chat archived');
        }

        // Main menu

        function runMainAction(action) {
            $('main-sheet').hidden = true;
            if (action === 'new-group') return openNewGroupPage();
            if (action === 'new-chat') return showTab('contacts');
            if (action === 'new-channel') return openPage('newchannel');
            if (action === 'starred') return openPage('starred');
            if (action === 'settings') return openPage('settings');
            if (action === 'logout') return logout();
        }

        // Groups: create

        function openNewGroupPage() { openPage('newgroup'); }

        function pageNewGroup() {
            return `
                <div class="section-title">Group name</div>
                <input class="field" id="ng-name" maxlength="50" placeholder="Group name">
                <div class="section-title">Add people</div>
                <div class="search-wrap" style="margin:0 0 8px">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input id="ng-search" placeholder="Search people" autocomplete="off">
                </div>
                <div class="list-card" id="ng-list">${checkListHTML(state.contacts, [], '')}</div>
                <p class="hint" style="margin-top:10px">Up to ${GROUP_MAX} members. You will be the group admin.</p>`;
        }

        function checkListHTML(people, selected, query = '') {
            const q = query.trim().toLowerCase();
            const list = people.filter(p => !q || p.username.toLowerCase().includes(q) || (p.displayName || '').toLowerCase().includes(q));
            if (!list.length) return '<div class="empty">No people found.</div>';
            return list.map(p => `
                <label class="check-row">
                    <input type="checkbox" data-member="${esc(p.username)}" ${selected.includes(p.username) ? 'checked' : ''}>
                    ${avatarHTML(p, 'avatar small')}
                    <div class="row-main"><div class="row-title">${esc(p.displayName || p.username)}</div><div class="row-sub">@${esc(p.username)}</div></div>
                </label>`).join('');
        }

        function createGroup() {
            const name = $('ng-name').value.trim();
            const members = [...document.querySelectorAll('[data-member]:checked')].map(i => i.dataset.member);
            if (!name) return toast('Give the group a name');
            if (!members.length) return toast('Choose at least one person');
            state.socket.emit('create-group', { name, members }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not create group');
                toast('Group created');
                closeAllPages();
                loadConversations();
                showTab('groups');
                openGroupChat(res.group._id);
            });
        }

        // Group info

        function openGroupInfo() {
            const g = state.chat.group;
            if (!g) return;
            openPage('groupinfo', { groupId: g._id });
        }

        function pageGroupInfo() {
            const g = state.pageData.group;
            if (!g) return '<div class="empty">Loading…</div>';
            const canEdit = g.isAdmin || g.membersCanEdit;
            const sorted = g.members.map(m => profileFor(m))
                .sort((a, b) => Number(g.admins.includes(b.username)) - Number(g.admins.includes(a.username)));

            return `
                <div class="profile-card">
                    <button class="avatar-btn" ${g.isAdmin ? 'data-action="g-photo"' : ''} style="position:relative;background:none" aria-label="Group photo">
                        ${groupAvatarHTML(g, 'avatar xl')}
                        ${g.isAdmin ? '<span class="cam-badge"><i class="fa-solid fa-camera"></i></span>' : ''}
                    </button>
                    <div class="pc-name" ${canEdit ? 'data-action="g-rename" style="cursor:pointer"' : ''}>${esc(g.name)}</div>
                    <div class="pc-about" ${canEdit ? 'data-action="g-desc" style="cursor:pointer"' : ''}>${esc(g.description || (canEdit ? 'Add a group description' : ''))}</div>
                    <div class="hint">Group · ${plural(g.members.length, 'member')}</div>
                </div>

                <div class="action-row">
                    <button class="action-pill" data-action="g-audio"><i class="fa-solid fa-phone"></i>Audio</button>
                    <button class="action-pill" data-action="g-video"><i class="fa-solid fa-video"></i>Video</button>
                    <button class="action-pill" data-action="g-search"><i class="fa-solid fa-magnifying-glass"></i>Search</button>
                    <button class="action-pill" data-page="media" data-media-group="${esc(g._id)}"><i class="fa-solid fa-photo-film"></i>Media</button>
                    ${g.isAdmin ? `<button class="action-pill" data-action="g-add"><i class="fa-solid fa-user-plus"></i>Add</button>` : ''}
                </div>

                ${g.isAdmin ? `
                <div class="section-title">Group settings</div>
                <div class="list-card">
                    <div class="list-row" data-action="g-rename" style="cursor:pointer">
                        <div class="row-main"><div class="row-title">Group name</div><div class="hint">${esc(g.name)}</div></div>
                        <i class="fa-solid fa-chevron-right" style="color:var(--muted)"></i>
                    </div>
                    <div class="list-row" data-action="g-desc" style="cursor:pointer">
                        <div class="row-main"><div class="row-title">Description</div><div class="hint">${esc(g.description || 'None')}</div></div>
                        <i class="fa-solid fa-chevron-right" style="color:var(--muted)"></i>
                    </div>
                    <label class="list-row">
                        <div class="row-main"><div class="row-title">Only admins can send</div><div class="hint">Turns the group into an announcement channel</div></div>
                        <span class="switch"><input type="checkbox" data-group-setting="announcementOnly" ${g.announcementOnly ? 'checked' : ''}><span class="track"></span></span>
                    </label>
                    <label class="list-row">
                        <div class="row-main"><div class="row-title">Members can edit group info</div><div class="hint">Name, description and photo</div></div>
                        <span class="switch"><input type="checkbox" data-group-setting="membersCanEdit" ${g.membersCanEdit ? 'checked' : ''}><span class="track"></span></span>
                    </label>
                </div>` : ''}

                <div class="section-title">${plural(g.members.length, 'member')}</div>
                <div class="list-card">
                    ${sorted.map(p => `
                        <button class="member-row" data-action="g-member" data-user="${esc(p.username)}">
                            ${avatarHTML(p, 'avatar small')}
                            <div class="row-main">
                                <div class="row-title">${esc(p.username === state.user ? 'You' : (p.displayName || p.username))}</div>
                                <div class="row-sub">${esc(p.about || '@' + p.username)}</div>
                            </div>
                            ${g.createdBy === p.username ? '<span class="admin-tag">Creator</span>' : (g.admins.includes(p.username) ? '<span class="admin-tag">Admin</span>' : '')}
                        </button>`).join('')}
                </div>

                <div class="menu-list" style="margin-top:14px">
                    <button class="menu-row danger" data-action="g-exit">
                        <span class="menu-ico"><i class="fa-solid fa-right-from-bracket"></i></span>
                        <span class="menu-text">Exit group</span>
                    </button>
                    ${g.isAdmin ? `
                    <button class="menu-row danger" data-action="g-delete">
                        <span class="menu-ico"><i class="fa-solid fa-trash-can"></i></span>
                        <span class="menu-text">Delete group</span>
                    </button>` : ''}
                </div>`;
        }

        function loadGroupInfo(groupId) {
            state.socket.emit('get-group-info', { groupId }, (res) => {
                if (!res || !res.success) { closeAllPages(); return toast(res?.error || 'Group not found'); }
                state.pageData.group = res.group;
                Object.assign(state.profiles, res.profiles);
                if (state.chat.kind === 'group' && state.chat.groupId === groupId) {
                    state.chat.group = res.group;
                    renderChatHeader();
                    renderComposer();
                }
                if (state.pages.length && state.pages[state.pages.length - 1] === 'groupinfo') renderPage();
            });
        }

        function openMemberSheet(username) {
            const g = state.pageData.group || state.chat.group;
            if (!g || username === state.user) return;
            state.memberTarget = username;
            const isAdmin = g.admins.includes(username);
            const isCreator = g.createdBy === username;
            $('member-sheet-body').innerHTML = `
                <div class="sheet-grip"></div>
                <button data-member-action="profile">View profile</button>
                ${g.isAdmin ? `
                <button data-member-action="${isAdmin ? 'admin-off' : 'admin-on'}" ${isCreator && isAdmin ? 'disabled' : ''}>${isAdmin ? 'Remove as admin' : 'Make group admin'}</button>
                <button data-member-action="remove" class="danger-text" ${isCreator ? 'disabled' : ''}>Remove from group</button>` : ''}
                <button data-member-action="close">Cancel</button>`;
            $('member-sheet').hidden = false;
        }

        function runMemberAction(action) {
            const target = state.memberTarget;
            const g = state.pageData.group || state.chat.group;
            $('member-sheet').hidden = true;
            if (!target || action === 'close') return;
            if (action === 'profile') return openPage('userprofile', { username: target });
            if (!g) return;

            if (action === 'admin-on' || action === 'admin-off') {
                state.socket.emit('set-group-admin', { groupId: g._id, target, admin: action === 'admin-on' }, (res) => {
                    if (!res || !res.success) toast(res?.error || 'Could not update');
                    else loadGroupInfo(g._id);
                });
            }
            if (action === 'remove') {
                if (!confirm(`Remove ${nameOf(target)} from the group?`)) return;
                state.socket.emit('remove-group-member', { groupId: g._id, target }, (res) => {
                    if (!res || !res.success) toast(res?.error || 'Could not remove');
                    else { toast('Removed'); loadGroupInfo(g._id); }
                });
            }
        }

        function renameGroup() {
            const g = state.pageData.group;
            if (!g) return;
            const name = prompt('Group name', g.name);
            if (name === null || !name.trim()) return;
            state.socket.emit('update-group', { groupId: g._id, name: name.trim() }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not rename');
                toast('Group name updated');
                loadGroupInfo(g._id);
                loadConversations();
            });
        }

        function editGroupDescription() {
            const g = state.pageData.group;
            if (!g) return;
            const description = prompt('Group description', g.description || '');
            if (description === null) return;
            state.socket.emit('update-group', { groupId: g._id, description }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not save');
                loadGroupInfo(g._id);
            });
        }

        async function changeGroupPhoto() {
            const g = state.pageData.group;
            if (!g) return;
            const file = await pickFile();
            if (!file) return;
            const data = await openEditor(file, { square: true, outMax: 400, limit: 600 * 1024 });
            if (!data) return;
            state.socket.emit('update-group', { groupId: g._id, photo: data }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not save photo');
                toast('Group photo updated');
                loadGroupInfo(g._id);
                loadConversations();
            });
        }

        function setGroupSetting(key, value) {
            const g = state.pageData.group;
            if (!g) return;
            state.socket.emit('update-group', { groupId: g._id, [key]: value }, (res) => {
                if (!res || !res.success) toast(res?.error || 'Could not save');
                loadGroupInfo(g._id);
            });
        }

        function exitGroup() {
            const g = state.pageData.group || state.chat.group;
            if (!g || !confirm(`Exit "${g.name}"?`)) return;
            state.socket.emit('leave-group', { groupId: g._id }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not leave');
                toast('You left the group');
                closeChat(true);
                closeAllPages();
                loadConversations();
                showTab('groups');
            });
        }

        function deleteGroup() {
            const g = state.pageData.group || state.chat.group;
            if (!g) return;
            if (!confirm(`Delete "${g.name}" for everyone? All messages will be removed.`)) return;
            state.socket.emit('delete-group', { groupId: g._id }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not delete group');
                toast('Group deleted');
                closeChat(true);
                closeAllPages();
                loadConversations();
                showTab('groups');
            });
        }

        function clearGroupChat() {
            const g = state.chat.group;
            if (!g || !confirm('Clear this group chat on your side?')) return;
            state.socket.emit('clear-group-chat', { groupId: g._id }, (res) => {
                if (!res || !res.success) toast(res?.error || 'Could not clear chat');
            });
        }

        function pageAddMembers() {
            const g = state.pageData.group;
            const candidates = state.contacts.filter(p => !g.members.includes(p.username));
            return `
                <div class="search-wrap" style="margin:0 0 8px">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input id="am-search" placeholder="Search people" autocomplete="off">
                </div>
                <div class="list-card" id="am-list">${candidates.length ? checkListHTML(candidates, []) : '<div class="empty">Everyone you know is already in this group.</div>'}</div>
                ${candidates.length ? '<button class="btn primary block" style="margin-top:14px" data-action="am-save">Add selected</button>' : ''}`;
        }

        function saveAddMembers() {
            const g = state.pageData.group;
            const members = [...document.querySelectorAll('[data-member]:checked')].map(i => i.dataset.member);
            if (!members.length) return toast('Choose people to add');
            state.socket.emit('add-group-members', { groupId: g._id, members }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not add members');
                toast('Members added');
                backPage();
                loadGroupInfo(g._id);
            });
        }

        // User profile (opened from a chat header, a group member, or Contacts)

        function openUserProfile(username) {
            openPage('userprofile', { username });
        }

        function loadUserProfile(username) {
            state.socket.emit('get-profile', { username }, (res) => {
                if (!res || !res.success) { closeAllPages(); return toast(res?.error || 'User not found'); }
                state.pageData.profile = res.profile;
                state.profiles[username] = res.profile;
                if (state.pages.length && state.pages[state.pages.length - 1] === 'userprofile') renderPage();
            });
        }

        function pageUserProfile() {
            const p = state.pageData.profile;
            if (!p) return '<div class="empty">Loading…</div>';
            const blocked = S().blockedUsers.includes(p.username);
            const status = p.online ? 'Online' : (p.lastSeen ? 'last seen ' + formatLastSeen(p.lastSeen) : '');
            return `
                <div class="profile-card">
                    ${avatarHTML(p, 'avatar xl')}
                    <div class="pc-name">${esc(p.displayName || p.username)}</div>
                    <div class="hint" style="${p.online ? 'color:var(--activity);font-weight:600' : ''}">${esc(status)}</div>
                </div>
                <div class="action-row">
                    <button class="action-pill" data-action="profile-audio"><i class="fa-solid fa-phone"></i>Audio</button>
                    <button class="action-pill" data-action="profile-video"><i class="fa-solid fa-video"></i>Video</button>
                    <button class="action-pill" data-action="profile-search"><i class="fa-solid fa-magnifying-glass"></i>Search</button>
                    <button class="action-pill" data-action="profile-message"><i class="fa-solid fa-comment"></i>Message</button>
                </div>
                <div class="section-title">About</div>
                <div class="info-card">
                    <div class="info-row"><i class="fa-solid fa-circle-info"></i><div><div class="k">Bio</div><div class="v">${esc(p.about || 'No bio yet')}</div></div></div>
                    <div class="info-row"><i class="fa-solid fa-at"></i><div><div class="k">Username</div><div class="v">@${esc(p.username)}</div></div></div>
                    <div class="info-row"><i class="fa-solid fa-phone"></i><div><div class="k">Phone number</div><div class="v">${p.phone ? esc(p.phone) : 'Hidden or not set'}</div></div></div>
                </div>
                <div class="menu-list">
                    <button class="menu-row" data-page="media" data-media-user="${esc(p.username)}"><span class="menu-ico"><i class="fa-solid fa-photo-film"></i></span><span class="menu-text">Media, links and docs</span><i class="fa-solid fa-chevron-right" style="color:var(--muted)"></i></button>
                    <button class="menu-row" data-action="profile-starred"><span class="menu-ico"><i class="fa-solid fa-star"></i></span><span class="menu-text">Starred messages</span><i class="fa-solid fa-chevron-right" style="color:var(--muted)"></i></button>
                    <button class="menu-row" data-soon="1"><span class="menu-ico"><i class="fa-solid fa-hourglass-half"></i></span><span class="menu-text">Disappearing messages<div class="menu-sub">Coming soon</div></span><i class="fa-solid fa-chevron-right" style="color:var(--muted)"></i></button>
                </div>
                <div class="menu-list">
                    <button class="menu-row danger" data-action="profile-report"><span class="menu-ico"><i class="fa-solid fa-flag"></i></span><span class="menu-text">Report ${esc(p.username)}</span></button>
                    <button class="menu-row danger" data-action="profile-block"><span class="menu-ico"><i class="fa-solid fa-user-slash"></i></span><span class="menu-text">${blocked ? 'Unblock' : 'Block'} ${esc(p.username)}</span></button>
                </div>`;
        }
        // Shared media

        function openMedia(data) {
            openPage('media', data);
        }

        function loadMedia(data) {
            const payload = data.groupId ? { groupId: data.groupId } : { target: data.target };
            state.socket.emit('get-media', payload, (res) => {
                if (!res || !res.success) { closeAllPages(); return toast(res?.error || 'Could not load media'); }
                state.pageData.media = res.media;
                if (state.pages.length && state.pages[state.pages.length - 1] === 'media') renderPage();
            });
        }

        function pageMedia() {
            const items = state.pageData.media;
            if (!items) return '<div class="empty">Loading…</div>';
            const photos = items.filter(m => m.image);
            const voices = items.filter(m => m.audio);
            if (!items.length) return '<div class="empty big"><i class="fa-solid fa-photo-film"></i><h3>No media yet</h3><p>Photos and voice notes shared here will appear.</p></div>';
            return `
                ${photos.length ? `<div class="section-title">Photos · ${photos.length}</div>
                <div class="media-grid">${photos.map(m => `<img src="${esc(m.image)}" alt="Photo" data-lightbox="${esc(m._id)}">`).join('')}</div>` : ''}
                ${voices.length ? `<div class="section-title">Voice notes · ${voices.length}</div>
                <div class="list-card">${voices.map(m => `
                    <div class="info-row" style="padding:12px 0">
                        <i class="fa-solid fa-microphone"></i>
                        <div class="grow"><div class="k">${esc(nameOf(m.sender))} · ${fmtDay(m.timestamp)}</div>
                        <audio controls preload="none" src="${esc(m.audio)}" style="width:100%;margin-top:6px;height:40px"></audio></div>
                    </div>`).join('')}</div>` : ''}`;
        }

        // Starred messages

        function loadStarredIds() {
            if (!state.socket) return;
            state.socket.emit('get-starred-ids', (res) => {
                if (!res || !res.success) return;
                state.starredIds = new Set(res.ids);
            });
        }

        function loadStarred() {
            state.socket.emit('get-starred', (res) => {
                if (!res || !res.success) return;
                state.pageData.starred = res.messages;
                state.starredIds = new Set(res.messages.map(m => m._id));
                if (state.pages.length && state.pages[state.pages.length - 1] === 'starred') renderPage();
            });
        }

        function pageStarred() {
            const list = state.pageData.starred;
            if (!list) return '<div class="empty">Loading…</div>';
            if (!list.length) return '<div class="empty big"><i class="fa-solid fa-star"></i><h3>No starred messages</h3><p>Long press a message and tap Star to save it here.</p></div>';
            return `<div class="list-card">${list.map(m => `
                <div class="starred-row">
                    <i class="fa-solid fa-star" style="color:#EAB308;margin-top:4px"></i>
                    <div class="grow">
                        <div class="k" style="font-size:13px;color:var(--muted)">${esc(m.chat)} · ${fmtDay(m.timestamp)}</div>
                        <div style="margin-top:3px">${esc(m.text || (m.image ? 'Photo' : (m.audio ? 'Voice message' : '')))}</div>
                    </div>
                    <button class="icon-btn" data-unstar="${esc(m._id)}" aria-label="Unstar"><i class="fa-solid fa-star-half-stroke"></i></button>
                </div>`).join('')}</div>`;
        }

        // Group chat

        function openGroupChat(groupId) {
            closeChat(true);
            state.chat = { ...emptyChat(), kind: 'group', groupId };
            $('chat').hidden = false;
            $('chat-messages').innerHTML = '';
            $('chat-title').textContent = 'Loading…';
            $('chat-sub').textContent = '';
            applyChatStyle();
            renderComposer();
            renderOneViewBtn();

            state.socket.emit('join-group', { groupId }, (res) => {
                if (state.chat.groupId !== groupId) return;
                if (!res || !res.success) { toast(res?.error || 'Could not open group'); return closeChat(); }
                state.chat.group = res.group;
                Object.assign(state.profiles, res.profiles);
                $('chat-messages').innerHTML = res.messages.map(m => bubbleHTML(m)).join('');
                renderChatHeader();
                renderComposer();
                scrollBottom();
                
            });
        }

        function onGroupsChanged() {
            loadConversations();
            if (state.chat.kind === 'group' && state.chat.groupId) {
                state.socket.emit('get-group-info', { groupId: state.chat.groupId }, (res) => {
                    if (!res || !res.success) return closeChat();
                    state.chat.group = res.group;
                    Object.assign(state.profiles, res.profiles);
                    renderChatHeader();
                    renderComposer();
                });
            }
            if (state.pages.length && state.pages[state.pages.length - 1] === 'groupinfo' && state.pageData.group) {
                loadGroupInfo(state.pageData.group._id);
            }
        }

        function onGroupDeleted({ groupId }) {
            if (state.chat.kind === 'group' && state.chat.groupId === groupId) { closeChat(true); toast('This group was deleted'); }
            if (state.pageData.group && state.pageData.group._id === groupId) closeAllPages();
            loadConversations();
        }

        function onGroupCleared({ groupId }) {
            if (state.chat.kind === 'group' && state.chat.groupId === groupId) $('chat-messages').innerHTML = '';
            loadConversations();
        }

        function onGroupMessage(msg) {
            const isOpen = state.chat.kind === 'group' && state.chat.groupId === msg.groupId;
            if (isOpen) {
                if (msg.sender !== state.user && !$('chat-messages').querySelector(`[data-id="${cssEsc(msg._id)}"]`)) {
                    $('chat-messages').insertAdjacentHTML('beforeend', bubbleHTML(msg));
                    scrollBottom();
                }
                if (msg.sender !== state.user) state.socket.emit('mark-group-read', { groupId: msg.groupId });
            } else if (msg.sender !== state.user) {
                if (S().sound) playBeep();
                const group = state.groups.find(g => g._id === msg.groupId);
                toast(`${group ? group.name : 'Group'}: ${msg.text || 'New message'}`);
            }
            scheduleConversations();
        }

        function onGroupMessageDeleted({ messageId }) { onMessageDeleted({ messageId }); }

        // Reports: the server copies the content, so the report can't be altered

        function openReport(type, id) {
            if (!id) return;
            state.reportTarget = { type, id };
            $('msg-sheet').hidden = true;
            $('report-sheet').hidden = false;
        }

        function submitReport(reason) {
            const target = state.reportTarget;
            state.reportTarget = null;
            $('report-sheet').hidden = true;
            if (!target || reason === 'cancel') return;
            state.socket.emit('report-content', { targetType: target.type, targetId: target.id, reason }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not send the report');
                toast('Thank you. The report was sent to the admin.');
            });
        }

        // Loads earlier messages when the chat is scrolled to the top
        function loadOlderMessages() {
            const c = state.chat;
            if (!c.kind || c.loadingOlder || c.hasMore === false || !state.socket) return;
            const box = $('chat-messages');
            const first = [...box.querySelectorAll('[data-id]')]
                .map(el => state.messageIndex.get(el.dataset.id))
                .find(m => m && m.timestamp);
            if (!first) return;

            c.loadingOlder = true;
            const payload = c.kind === 'group'
                ? { groupId: c.groupId, before: first.timestamp }
                : { target: c.partner, before: first.timestamp };

            state.socket.emit('load-older', payload, (res) => {
                c.loadingOlder = false;
                if (state.chat !== c || !res || !res.success) return;
                if (!res.hasMore || !res.messages.length) c.hasMore = false;
                if (!res.messages.length) return;

                const previousHeight = box.scrollHeight;
                box.style.scrollBehavior = 'auto';
                box.insertAdjacentHTML('afterbegin', res.messages.map(m => bubbleHTML(m)).join(''));
                box.scrollTop = box.scrollHeight - previousHeight;
                box.style.scrollBehavior = '';
            });
        }

        // Edits and reactions (both private and group chats)

        function refreshBubble(id) {
            const m = state.messageIndex.get(String(id));
            const el = $('chat-messages').querySelector(`[data-id="${cssEsc(id)}"]`);
            if (!m || !el) return;
            el.outerHTML = bubbleHTML(m);
        }

        function onMessageEdited({ messageId, text }) {
            const m = state.messageIndex.get(String(messageId));
            if (m) { m.text = text; m.edited = true; }
            refreshBubble(messageId);
            loadConversations();
        }

        function onMessageReaction({ messageId, reactions }) {
            const m = state.messageIndex.get(String(messageId));
            if (m) m.reactions = reactions;
            refreshBubble(messageId);
        }

        // Channels: admins post, followers read and react

        function loadChannels() {
            if (!state.socket) return;
            state.socket.emit('get-my-channels', (res) => {
                if (!res || !res.success) return;
                state.channels = res.channels;
                renderChannelList();
            });
        }

        function channelRowHTML(c) {
            const last = c.lastPost;
            return `
                <button class="channel-row" data-channel="${esc(c._id)}">
                    ${groupAvatarHTML({ _id: c._id, name: c.name, photo: c.photo }, 'avatar')}
                    <div class="row-main">
                        <div class="row-title">${esc(c.name)}<span class="group-tag"><i class="fa-solid fa-bullhorn"></i> Channel</span></div>
                        <div class="row-sub">${last ? esc(last.text) : 'No posts yet'}</div>
                    </div>
                    <div class="row-side"><span class="row-time">${last ? fmtDay(last.timestamp) : ''}</span></div>
                </button>`;
        }

        function renderChannelList() {
            if (state.tab !== 'status') return;
            const list = $('channel-list');
            if (!list) return;
            list.innerHTML = state.channels.length
                ? state.channels.map(channelRowHTML).join('')
                : '<div class="empty" style="padding:22px 26px">Follow a channel to see its updates here.</div>';
        }

        function openExploreChannels() { openPage('explore'); }

        function pageExplore() {
            return `
                <div class="search-wrap" style="margin:0 0 8px">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input id="ex-search" placeholder="Search channels" autocomplete="off">
                </div>
                <div class="list-card" id="ex-list"><div class="empty">Loading…</div></div>`;
        }

        function loadExplore(q) {
            state.socket.emit('explore-channels', { q: q || '' }, (res) => {
                const list = $('ex-list');
                if (!res || !res.success || !list) return;
                list.innerHTML = res.channels.length
                    ? res.channels.map(c => `
                        <div class="check-row" style="cursor:default">
                            ${groupAvatarHTML({ _id: c._id, name: c.name, photo: c.photo }, 'avatar small')}
                            <button class="row-main" data-channel="${esc(c._id)}" style="text-align:left">
                                <div class="row-title">${esc(c.name)}</div>
                                <div class="row-sub">${plural(c.subscriberCount, 'follower')}</div>
                            </button>
                            <button class="btn small ${c.subscribed ? '' : 'primary'}" data-subscribe="${esc(c._id)}" data-on="${c.subscribed ? '0' : '1'}">${c.subscribed ? 'Following' : 'Follow'}</button>
                        </div>`).join('')
                    : '<div class="empty">No channels yet. Create the first one.</div>';
            });
        }

        function setSubscription(channelId, on, done) {
            state.socket.emit('set-channel-subscription', { channelId, on }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not update');
                toast(on ? 'Following channel' : 'Unfollowed');
                if (state.channelView && state.channelView.id === channelId) {
                    state.channelView.info = res.channel;
                    renderChannelHeader();
                    renderChannelComposer();
                    loadChannelPosts(channelId);
                }
                if (state.pageData.channel && state.pageData.channel._id === channelId) loadChannelInfo(channelId);
                loadChannels();
                if (state.pages.length && state.pages[state.pages.length - 1] === 'explore') loadExplore($('ex-search')?.value || '');
                if (done) done(res.channel);
            });
        }

        function toggleExploreSub(channelId, on) { setSubscription(channelId, on); }

        function toggleChannelSubscription() {
            const c = state.channelView?.info || state.pageData.channel;
            if (!c) return;
            setSubscription(c._id, !c.subscribed);
        }

        function pageNewChannel() {
            return `
                <div class="profile-card" style="padding-top:8px">
                    <button id="nc-photo-btn" data-action="nc-photo" style="position:relative;background:none">
                        <span class="avatar xl square" id="nc-photo-preview" style="background:var(--surface-3);color:var(--muted)"><i class="fa-solid fa-bullhorn"></i></span>
                        <span class="cam-badge"><i class="fa-solid fa-camera"></i></span>
                    </button>
                </div>
                <div class="section-title">Name</div>
                <input class="field" id="nc-name" maxlength="50" placeholder="Channel name">
                <div class="section-title">Description</div>
                <textarea class="field" id="nc-desc" maxlength="300" placeholder="What is this channel about?"></textarea>
                <p class="hint" style="margin-top:10px">Only you and the admins you choose can post. Anyone can follow.</p>
                <button class="btn primary block" style="margin-top:18px" data-action="nc-create">Create channel</button>`;
        }

        async function pickChannelPhoto() {
            const file = await pickFile();
            if (!file) return;
            const data = await openEditor(file, { square: true, outMax: 400, limit: 600 * 1024 });
            if (!data) return;
            state.pageData.channelPhoto = data;
            const preview = $('nc-photo-preview');
            if (preview) preview.innerHTML = `<img src="${esc(data)}" alt="">`;
        }

        function createChannel() {
            const name = $('nc-name').value.trim();
            const description = $('nc-desc').value.trim();
            if (!name) return toast('Give the channel a name');
            state.socket.emit('create-channel', { name, description, photo: state.pageData.channelPhoto || null }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not create channel');
                toast('Channel created');
                closeAllPages();
                loadChannels();
                showTab('status');
                openChannel(res.channel._id);
            });
        }

        function openChannel(id) {
            state.channelView = { id, info: null };
            state.channelPosts = [];
            $('channel').hidden = false;
            $('channel-posts').innerHTML = '<div class="empty">Loading…</div>';
            $('channel-title').textContent = '';
            $('channel-sub').textContent = '';
            $('channel-avatar').innerHTML = '';
            state.socket.emit('get-channel', { channelId: id }, (res) => {
                if (!state.channelView || state.channelView.id !== id) return;
                if (!res || !res.success) { closeChannel(); return toast(res?.error || 'Channel not found'); }
                state.channelView.info = res.channel;
                renderChannelHeader();
                renderChannelComposer();
            });
            loadChannelPosts(id);
        }

        function loadChannelPosts(id) {
            state.socket.emit('get-channel-posts', { channelId: id }, (res) => {
                if (!state.channelView || state.channelView.id !== id) return;
                if (!res || !res.success) {
                    state.channelPosts = [];
                    $('channel-posts').innerHTML = `<div class="empty">${esc(res?.error || 'Follow this channel to see its posts')}</div>`;
                    return;
                }
                state.channelPosts = res.posts;
                renderChannelPosts();
            });
        }

        function closeChannel() {
            $('channel').hidden = true;
            $('channel-posts').innerHTML = '';
            $('post-sheet').hidden = true;
            state.channelView = null;
            state.channelPosts = [];
        }

        function renderChannelHeader() {
            const c = state.channelView?.info;
            if (!c) return;
            $('channel-title').textContent = c.name;
            $('channel-avatar').innerHTML = groupAvatarHTML({ _id: c._id, name: c.name, photo: c.photo }, 'avatar small');
            $('channel-sub').textContent = `${plural(c.subscriberCount, 'follower')}${c.isAdmin ? ' · You are an admin' : ''}`;
        }

        function renderChannelComposer() {
            const c = state.channelView?.info;
            const box = $('channel-composer');
            const notice = $('channel-notice');
            const row = $('channel-compose-row');
            if (!c) { box.hidden = true; return; }
            box.hidden = false;
            if (!c.subscribed) {
                notice.hidden = false;
                notice.innerHTML = `<span>Follow this channel to read its posts.</span><button class="btn small primary" data-channel-sub="1">Follow</button>`;
                row.hidden = true;
            } else if (!c.isAdmin) {
                notice.hidden = false;
                notice.innerHTML = '<span>Only admins can post. You can react to posts.</span>';
                row.hidden = true;
            } else {
                notice.hidden = true;
                row.hidden = false;
            }
        }

        function postHTML(p) {
            if (p.deleted) return `<div class="post post-deleted"><i class="fa-solid fa-ban"></i> This post was deleted</div>`;
            const counts = p.counts || {};
            const reactions = Object.keys(counts).map(e =>
                `<span class="post-react ${p.myReaction === e ? 'on' : ''}" data-post-react="${esc(p._id)}" data-emoji="${esc(e)}">${e} ${counts[e]}</span>`).join('');
            return `
                <div class="post" data-post="${esc(p._id)}">
                    <div class="post-meta"><span>${esc(state.channelView?.info?.name || 'Channel')}</span><span style="display:inline-flex;align-items:center;gap:6px">${fmtTime(p.timestamp)}${state.channelView?.info?.isAdmin ? `<button class="icon-btn danger" data-cdel="${esc(p._id)}" aria-label="Delete post" style="width:30px;height:30px;font-size:14px"><i class="fa-solid fa-trash-can"></i></button>` : ''}</span></div>
                    ${p.image ? `<img class="post-img" src="${esc(p.image)}" alt="Photo">` : ''}
                    ${p.audio ? `<audio controls preload="metadata" src="${esc(p.audio)}" style="width:100%;height:42px;margin-bottom:6px"></audio>` : ''}
                    ${p.text ? `<div class="post-text">${esc(p.text)}</div>` : ''}
                    ${reactions ? `<div class="post-reactions">${reactions}</div>` : ''}
                </div>`;
        }

        function renderChannelPosts() {
            state.channelPosts = state.channelPosts.filter((p, i, arr) => arr.findIndex(q => q._id === p._id) === i);
            const list = $('channel-posts');
            list.innerHTML = state.channelPosts.length
                ? state.channelPosts.map(postHTML).join('')
                : '<div class="empty">No posts yet.</div>';
            list.scrollTop = list.scrollHeight;
        }

        function postToChannel() {
            const c = state.channelView?.info;
            const input = $('channel-input');
            const text = input.value.trim();
            if (!c || !text) return;
            state.socket.emit('post-channel', { channelId: c._id, text }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not post');
                input.value = '';
                state.channelPosts.push(res.post);
                renderChannelPosts();
                loadChannels();
            });
        }

        async function postChannelPhoto() {
            const c = state.channelView?.info;
            if (!c) return;
            const file = await pickFile();
            if (!file) return;
            const image = await openEditor(file, { outMax: 1280 });
            if (!image) return;
            state.socket.emit('post-channel', { channelId: c._id, image }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not post');
                state.channelPosts.push(res.post);
                renderChannelPosts();
                loadChannels();
            });
        }

        let channelRec = null;

        async function toggleChannelVoice() {
            if (channelRec) { channelRec.recorder.stop(); return; }
            const c = state.channelView?.info;
            if (!c || !c.isAdmin) return;
            if (!navigator.mediaDevices || !window.MediaRecorder) return toast('Voice notes are not supported in this browser');
            let stream;
            try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
            catch (err) { return toast('Allow microphone access to record voice posts'); }

            const chunks = [];
            const recorder = new MediaRecorder(stream);
            const startedAt = Date.now();
            recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
            recorder.onstop = async () => {
                stream.getTracks().forEach(t => t.stop());
                channelRec = null;
                $('channel-voice').innerHTML = '<i class="fa-solid fa-microphone"></i>';
                const type = (recorder.mimeType || 'audio/webm').split(';')[0];
                const blob = new Blob(chunks, { type });
                if (!blob.size) return;
                const audio = await blobToDataUrl(blob);
                if (audio.length > AUDIO_LIMIT) return toast('That voice note is too long to post');
                const audioDuration = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
                state.socket.emit('post-channel', { channelId: c._id, audio, audioDuration }, (res) => {
                    if (!res || !res.success) return toast(res?.error || 'Could not post');
                    state.channelPosts.push(res.post);
                    renderChannelPosts();
                    loadChannels();
                });
            };
            channelRec = { recorder };
            recorder.start();
            $('channel-voice').innerHTML = '<i class="fa-solid fa-stop"></i>';
            setTimeout(() => { if (channelRec && channelRec.recorder === recorder && recorder.state !== 'inactive') recorder.stop(); }, MAX_VOICE_SECONDS * 1000);
        }

        function reactToPost(postId, emoji) {
            const p = state.channelPosts.find(x => x._id === postId);
            if (!p) return;
            const next = p.myReaction === emoji ? null : emoji;
            state.socket.emit('react-channel-post', { postId, emoji: next }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not react');
                p.counts = res.counts;
                p.myReaction = res.myReaction;
                renderChannelPosts();
            });
        }

        function openPostSheet(postId) {
            const p = state.channelPosts.find(x => x._id === postId);
            if (!p || p.deleted) return;
            state.postTarget = postId;
            const isAdmin = !!state.channelView?.info?.isAdmin;
            $('post-sheet-body').innerHTML = `
                <div class="sheet-grip"></div>
                <div class="react-row">
                    ${REACTIONS.map(e => `<button data-ch-react="${e}" class="${p.myReaction === e ? 'on' : ''}">${e}</button>`).join('')}
                </div>
                <button data-ch-act="report" class="danger-text"><i class="fa-solid fa-flag" style="width:24px"></i>&nbsp; Report post</button>
                ${isAdmin ? `<button data-ch-act="delete" class="danger-text"><i class="fa-solid fa-trash-can" style="width:24px"></i>&nbsp; Delete post</button>` : ''}
                <button data-ch-act="cancel">Cancel</button>`;
            $('post-sheet').hidden = false;
        }

        function openChannelMenu() {
            const c = state.channelView?.info;
            if (!c) return;
            state.postTarget = null;
            $('post-sheet-body').innerHTML = `
                <div class="sheet-grip"></div>
                <button data-ch-act="info"><i class="fa-solid fa-circle-info" style="width:24px;color:var(--accent)"></i>&nbsp; Channel info</button>
                <button data-ch-act="follow"><i class="fa-solid ${c.subscribed ? 'fa-bell-slash' : 'fa-bell'}" style="width:24px;color:var(--accent)"></i>&nbsp; ${c.subscribed ? 'Unfollow' : 'Follow'}</button>
                <button data-ch-act="cancel">Cancel</button>`;
            $('post-sheet').hidden = false;
        }

        function runPostSheetAction(act) {
            const postId = state.postTarget;
            $('post-sheet').hidden = true;
            if (act === 'cancel') return;
            if (act === 'info') return openChannelInfo(state.channelView?.id);
            if (act === 'follow') return toggleChannelSubscription();
            if (act === 'report' && postId) return openReport('channel-post', postId);
            if (act === 'delete' && postId) {
                if (!confirm('Delete this post for all followers?')) return;
                state.socket.emit('delete-channel-post', { postId }, (res) => {
                    if (!res || !res.success) toast(res?.error || 'Could not delete');
                });
            }
        }

        function openChannelInfo(id) {
            if (!id) return;
            openPage('channelinfo', { channelId: id });
        }

        function loadChannelInfo(id) {
            state.socket.emit('get-channel', { channelId: id }, (res) => {
                if (!res || !res.success) { closeAllPages(); return toast(res?.error || 'Channel not found'); }
                state.pageData.channel = res.channel;
                if (state.pages.length && state.pages[state.pages.length - 1] === 'channelinfo') renderPage();
            });
        }

        function pageChannelInfo() {
            const c = state.pageData.channel;
            if (!c) return '<div class="empty">Loading…</div>';
            const admins = c.admins.map(u => `
                <div class="member-row">
                    ${avatarHTML(profileFor(u), 'avatar small')}
                    <div class="row-main"><div class="row-title">${esc(u === state.user ? 'You' : (profileFor(u).displayName || u))}</div><div class="row-sub">@${esc(u)}</div></div>
                    ${c.createdBy === u ? '<span class="admin-tag">Owner</span>' : (c.isOwner ? `<button class="btn small danger" data-action="ch-remove-admin" data-user="${esc(u)}">Remove</button>` : '<span class="admin-tag">Admin</span>')}
                </div>`).join('');
            return `
                <div class="profile-card">
                    <button class="avatar-btn" ${c.isAdmin ? 'data-action="ch-photo"' : ''} style="position:relative;background:none">
                        ${groupAvatarHTML({ _id: c._id, name: c.name, photo: c.photo }, 'avatar xl')}
                        ${c.isAdmin ? '<span class="cam-badge"><i class="fa-solid fa-camera"></i></span>' : ''}
                    </button>
                    <div class="pc-name" ${c.isAdmin ? 'data-action="ch-rename" style="cursor:pointer"' : ''}>${esc(c.name)}</div>
                    <div class="pc-about" ${c.isAdmin ? 'data-action="ch-desc" style="cursor:pointer"' : ''}>${esc(c.description || (c.isAdmin ? 'Add a description' : ''))}</div>
                    <div class="hint">Channel · ${plural(c.subscriberCount, 'follower')}</div>
                </div>
                <div class="action-row">
                    <button class="action-pill ${c.subscribed ? 'danger' : ''}" data-action="ch-subscribe"><i class="fa-solid ${c.subscribed ? 'fa-bell-slash' : 'fa-bell'}"></i>${c.subscribed ? 'Unfollow' : 'Follow'}</button>
                    ${c.isOwner ? '<button class="action-pill" data-action="ch-add-admin"><i class="fa-solid fa-user-shield"></i>Add admin</button>' : ''}
                </div>
                <div class="section-title">Admins</div>
                <div class="list-card">${admins}</div>
                ${c.isOwner ? `
                <div class="menu-list" style="margin-top:14px">
                    <button class="menu-row danger" data-action="ch-delete">
                        <span class="menu-ico"><i class="fa-solid fa-trash-can"></i></span>
                        <span class="menu-text">Delete channel</span>
                    </button>
                </div>` : ''}`;
        }

        function changeChannelPhoto() {
            const c = state.pageData.channel;
            if (!c) return;
            pickFile().then(async (file) => {
                if (!file) return;
                const data = await openEditor(file, { square: true, outMax: 400, limit: 600 * 1024 });
                if (!data) return;
                state.socket.emit('update-channel', { channelId: c._id, photo: data }, (res) => {
                    if (!res || !res.success) return toast(res?.error || 'Could not save photo');
                    toast('Channel photo updated');
                    loadChannelInfo(c._id);
                    loadChannels();
                });
            });
        }

        function renameChannel() {
            const c = state.pageData.channel;
            if (!c) return;
            const name = prompt('Channel name', c.name);
            if (name === null || !name.trim()) return;
            state.socket.emit('update-channel', { channelId: c._id, name: name.trim() }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not rename');
                loadChannelInfo(c._id);
                loadChannels();
            });
        }

        function editChannelDescription() {
            const c = state.pageData.channel;
            if (!c) return;
            const description = prompt('Channel description', c.description || '');
            if (description === null) return;
            state.socket.emit('update-channel', { channelId: c._id, description }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not save');
                loadChannelInfo(c._id);
            });
        }

        function addChannelAdmin() {
            const c = state.pageData.channel;
            if (!c) return;
            const username = (prompt('Username of a follower to make admin') || '').trim();
            if (!username) return;
            state.socket.emit('set-channel-admin', { channelId: c._id, target: username, admin: true }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not add admin');
                toast('Admin added');
                loadChannelInfo(c._id);
            });
        }

        function removeChannelAdmin(username) {
            const c = state.pageData.channel;
            if (!c || !confirm(`Remove ${username} as admin?`)) return;
            state.socket.emit('set-channel-admin', { channelId: c._id, target: username, admin: false }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not remove admin');
                loadChannelInfo(c._id);
            });
        }

        function deleteChannel() {
            const c = state.pageData.channel;
            if (!c || !confirm(`Delete "${c.name}" for all followers? All posts will be removed.`)) return;
            state.socket.emit('delete-channel', { channelId: c._id }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not delete channel');
                toast('Channel deleted');
                closeChannel();
                closeAllPages();
                loadChannels();
            });
        }

        function deleteChannelPost(postId) {
            if (!confirm('Delete this post for all followers?')) return;
            state.socket.emit('delete-channel-post', { postId }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not delete the post');
                state.channelPosts = state.channelPosts.filter(p => p._id !== postId);
                renderChannelPosts();
                loadChannels();
            });
        }

        function openCall(kind) {
            const p = state.chat.partner ? profileFor(state.chat.partner) : null;
            if (!p) return toast('Open a chat to start a call');
            const id = kind === 'video' ? 'video-call' : 'voice-call';
            $(`${id}-avatar`).innerHTML = avatarHTML(p, 'avatar');
            $(`${id}-name`).textContent = p.displayName || p.username;
            $(id).hidden = false;
        }

        function closeCalls() {
            $('voice-call').hidden = true;
            $('video-call').hidden = true;
        }

        function onChannelPost({ channelId, post }) {
            if (state.channelView && state.channelView.id === channelId) {
                if (!state.channelPosts.some(p => p._id === post._id)) state.channelPosts.push(post);
                renderChannelPosts();
            } else {
                if (S().sound) playBeep();
                const ch = state.channels.find(c => c._id === channelId);
                toast(`${ch ? ch.name : 'Channel'}: ${post.text || 'New post'}`);
            }
            loadChannels();
        }

        function onChannelPostDeleted({ channelId, postId }) {
            const p = state.channelPosts.find(x => x._id === postId);
            if (p) { p.deleted = true; p.text = ''; p.image = null; p.audio = null; p.counts = {}; }
            if (state.channelView && state.channelView.id === channelId) renderChannelPosts();
            loadChannels();
        }

        function onChannelReaction({ postId, counts }) {
            const p = state.channelPosts.find(x => x._id === postId);
            if (!p) return;
            p.counts = counts;
            if (state.channelView) renderChannelPosts();
        }

        function onChannelsChanged({ channelId }) {
            loadChannels();
            if (state.channelView && state.channelView.id === channelId) {
                state.socket.emit('get-channel', { channelId }, (res) => {
                    if (!res || !res.success || !state.channelView) return;
                    state.channelView.info = res.channel;
                    renderChannelHeader();
                    renderChannelComposer();
                });
            }
            if (state.pageData.channel && state.pageData.channel._id === channelId) loadChannelInfo(channelId);
        }

        function onChannelDeleted({ channelId }) {
            if (state.channelView && state.channelView.id === channelId) {
                closeChannel();
                toast('This channel was deleted');
            }
            if (state.pageData.channel && state.pageData.channel._id === channelId) closeAllPages();
            loadChannels();
        }

        // Status tab

        function loadStatuses() {
            if (!state.socket) return;
            state.socket.emit('get-statuses', (res) => {
                if (!res || !res.success) return;
                state.statuses = res.statuses;
                state.profiles = { ...state.profiles, ...res.profiles };
                renderUpdates();
                refreshOpenViewer();
            });
        }

        function groupStatuses() {
            const map = new Map();
            for (const s of state.statuses) {
                if (!map.has(s.user)) map.set(s.user, []);
                map.get(s.user).push(s);
            }
            return map;
        }

        function renderUpdates() {
            if (state.tab !== 'status') return;
            $('my-status-avatar').innerHTML = avatarHTML(selfProfile(), 'avatar story-av');
            const groups = groupStatuses();
            const mine = groups.get(state.user) || [];
            const others = [...groups.entries()].filter(([user]) => user !== state.user);

            $('status-strip').innerHTML = `
                <button class="story" data-action="my-status">
                    <span class="ring ${mine.length ? 'seen' : ''}">${avatarHTML(selfProfile(), 'avatar story-av')}</span>
                    <span class="plus" data-action="add-status" aria-label="Add status"><i class="fa-solid fa-plus"></i></span>
                    <span class="story-name">My status</span>
                </button>` +
                others.map(([user, items]) => {
                    const p = profileFor(user);
                    const unseen = items.some(i => !i.viewedByMe);
                    return `
                        <button class="story" data-view="${esc(user)}">
                            <span class="ring ${unseen ? 'unseen' : 'seen'}">${avatarHTML(p, 'avatar story-av')}</span>
                            <span class="story-name">${esc(p.displayName || user)}</span>
                        </button>`;
                }).join('');

            const statusRowHTML = ([user, items]) => {
                const p = profileFor(user);
                const unseen = items.some(i => !i.viewedByMe);
                return `
                    <button class="row" data-view="${esc(user)}">
                        <span class="ring ${unseen ? 'unseen' : 'seen'}">${avatarHTML(p)}</span>
                        <div class="row-main">
                            <div class="row-title">${esc(p.displayName || user)}</div>
                            <div class="row-sub">${fmtDay(items[items.length - 1].timestamp)} · ${plural(items.length, 'update')}</div>
                        </div>
                    </button>`;
            };
            $('status-list').innerHTML = others.filter(x => x[1].some(i => !i.viewedByMe)).map(statusRowHTML).join('');
            $('status-viewed').innerHTML = others.filter(x => x[1].every(i => i.viewedByMe)).map(statusRowHTML).join('');

            $('status-empty').hidden = others.length > 0 || mine.length > 0;
            renderChannelList();
        }

        // Status viewer

        function openViewer(user) {
            const items = groupStatuses().get(user) || [];
            if (!items.length) return openStatusComposer();
            const firstUnseen = items.findIndex(i => !i.viewedByMe);
            state.viewer = { ...emptyViewer(), user, items, index: firstUnseen >= 0 ? firstUnseen : 0 };
            $('viewer').hidden = false;
            renderViewer();
            state.viewer.timer = setInterval(tickViewer, 50);
        }

        function renderViewer() {
            const v = state.viewer;
            const item = v.items[v.index];
            if (!item) return closeViewer();
            v.elapsed = 0;
            v.last = Date.now();
            if (!item.viewedByMe && item.user !== state.user) markViewed(item);

            const p = v.user === state.user ? selfProfile() : profileFor(v.user);
            $('viewer-avatar').innerHTML = avatarHTML(p, 'avatar small');
            $('viewer-name').textContent = v.user === state.user ? 'My status' : (p.displayName || v.user);
            $('viewer-time').textContent = fmtTime(item.timestamp);
            $('viewer-delete').hidden = v.user !== state.user;
            $('viewer-report').hidden = v.user === state.user;

            if (item.hasImage && !item.image && !item.loadingImage) {
                item.loadingImage = true;
                state.socket.emit('get-status-image', { statusId: item._id }, (res) => {
                    item.loadingImage = false;
                    if (!res || !res.success || !res.image) return;
                    item.image = res.image;
                    if (state.viewer.items[state.viewer.index] === item) renderViewer();
                });
            }
            const body = $('viewer-body');
            if (item.hasImage && !item.image) {
                body.innerHTML = '<div style="color:#fff;font-size:28px"><i class="fa-solid fa-spinner fa-spin"></i></div>';
            } else if (item.image) {
                body.innerHTML = `<img class="viewer-img" src="${esc(item.image)}" alt="Status photo">${item.text ? `<p class="viewer-caption">${esc(item.text)}</p>` : ''}`;
            } else {
                body.innerHTML = `<div class="viewer-text" style="background:${esc(item.bg || STATUS_BACKGROUNDS[0])}">${esc(item.text)}</div>`;
            }
            renderViewerBars();
            renderViewerFoot();
        }

        function renderViewerBars() {
            const v = state.viewer;
            $('viewer-bars').innerHTML = v.items.map((it, i) => {
                let width = 0;
                if (i < v.index) width = 100;
                else if (i === v.index) width = Math.min(100, (v.elapsed / STATUS_MS) * 100);
                return `<div class="bar"><span style="width:${width}%"></span></div>`;
            }).join('');
        }

        function tickViewer() {
            const v = state.viewer;
            if (!v.user) return;
            const now = Date.now();
            const dt = now - v.last;
            v.last = now;
            if (v.paused) return;
            v.elapsed += dt;
            if (v.elapsed >= STATUS_MS) return nextStatus();
            renderViewerBars();
        }

        function setViewerPaused(on) {
            const v = state.viewer;
            if (!v.user) return;
            v.paused = on;
            v.last = Date.now();
            $('viewer-paused').hidden = !on;
        }

        function markViewed(item) {
            item.viewedByMe = true;
            state.socket.emit('view-status', { statusId: item._id }, () => {});
        }

        function renderViewerFoot() {
            const v = state.viewer;
            const item = v.items[v.index];
            if (!item) return;
            if (v.user === state.user) {
                $('viewer-foot').innerHTML = `
                    <button class="foot-btn" data-viewers><i class="fa-solid fa-eye"></i>&nbsp; ${plural(item.viewCount || 0, 'view')}</button>
                    <button class="foot-btn" data-likers><i class="fa-solid fa-heart"></i>&nbsp; ${plural(item.likeCount || 0, 'like')}</button>`;
            } else {
                $('viewer-foot').innerHTML = `
                    <div class="reply-box"><input id="status-reply" placeholder="Reply..." autocomplete="off"></div>
                    <button class="foot-like ${item.likedByMe ? 'on' : ''}" data-like aria-label="${item.likedByMe ? 'Unlike' : 'Like'}">
                        <i class="fa-${item.likedByMe ? 'solid' : 'regular'} fa-heart"></i>
                    </button>`;
            }
        }

        function sendStatusReply() {
            const v = state.viewer;
            const input = $('status-reply');
            const text = input ? input.value.trim() : '';
            if (!v.user || v.user === state.user || !text) return;
            state.socket.emit('send-private-message', { receiver: v.user, text }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Reply not sent');
                input.value = '';
                toast('Reply sent');
            });
        }

        function toggleLike(item) {
            const liked = !item.likedByMe;
            state.socket.emit('like-status', { statusId: item._id, liked }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not like this status');
                item.likedByMe = liked;
                item.likeCount = Math.max(0, (item.likeCount || 0) + (liked ? 1 : -1));
                renderViewerFoot();
            });
        }

        function openStatusPeople(kind) {
            const v = state.viewer;
            if (!v.items[v.index]) return;
            v.sheet = kind;
            setViewerPaused(true);
            renderStatusPeople();
            $('people-sheet').hidden = false;
        }

        function closeStatusPeople() {
            $('people-sheet').hidden = true;
            state.viewer.sheet = null;
            if (state.viewer.user) setViewerPaused(false);
        }

        function renderStatusPeople() {
            const v = state.viewer;
            const item = v.items[v.index];
            if (!item) return closeStatusPeople();
            const views = item.viewers || [];
            const likers = item.likers || [];
            const kind = v.sheet || 'views';
            const list = kind === 'views'
                ? views.map(x => ({ username: x.username, at: x.at }))
                : likers.map(u => ({ username: u, at: null }));

            $('people-tabs').innerHTML = `
                <button class="people-tab ${kind === 'views' ? 'on' : ''}" data-kind="views"><i class="fa-solid fa-eye"></i> Views ${views.length}</button>
                <button class="people-tab ${kind === 'likes' ? 'on' : ''}" data-kind="likes"><i class="fa-solid fa-heart"></i> Likes ${likers.length}</button>`;
            $('people-list').innerHTML = list.length
                ? list.map(p => {
                    const prof = profileFor(p.username);
                    return `<div class="people-row">${avatarHTML(prof, 'avatar small')}
                        <div class="row-main"><div class="row-title">${esc(prof.displayName || p.username)}</div><div class="row-sub">@${esc(p.username)}</div></div>
                        <div class="hint">${p.at ? fmtTime(p.at) : ''}</div></div>`;
                }).join('')
                : `<div class="empty">${kind === 'views' ? 'No views yet' : 'No likes yet'}</div>`;
        }

        function refreshOpenViewer() {
            const v = state.viewer;
            if ($('viewer').hidden || !v.user) return;
            const items = groupStatuses().get(v.user) || [];
            if (!items.length) return closeViewer();
            const currentId = v.items[v.index]?._id;
            v.items = items;
            const idx = items.findIndex(i => i._id === currentId);
            v.index = idx >= 0 ? idx : Math.min(v.index, items.length - 1);
            renderViewerBars();
            renderViewerFoot();
            if (v.sheet) renderStatusPeople();
        }

        function nextStatus() {
            const v = state.viewer;
            if (v.index < v.items.length - 1) { v.index++; renderViewer(); } else closeViewer();
        }
        function prevStatus() {
            const v = state.viewer;
            if (v.index > 0) { v.index--; renderViewer(); }
        }
        function closeViewer() {
            const v = state.viewer;
            clearInterval(v.timer);
            clearTimeout(v.holdTimer);
            $('viewer').hidden = true;
            $('people-sheet').hidden = true;
            $('viewer-paused').hidden = true;
            state.viewer = emptyViewer();
            renderUpdates();
        }

        function bindViewerHold() {
            const viewer = $('viewer');
            viewer.addEventListener('pointerdown', (e) => {
                const v = state.viewer;
                if (!v.user || v.sheet || e.target.closest('button')) return;
                v.held = false;
                clearTimeout(v.holdTimer);
                v.holdTimer = setTimeout(() => { v.held = true; setViewerPaused(true); }, HOLD_MS);
            });
            const release = () => {
                const v = state.viewer;
                clearTimeout(v.holdTimer);
                if (v.held && !v.sheet) setViewerPaused(false);
            };
            ['pointerup', 'pointercancel', 'pointerleave'].forEach(evt => viewer.addEventListener(evt, release));
        }

        function deleteCurrentStatus() {
            const v = state.viewer;
            const item = v.items[v.index];
            if (!item || !confirm('Delete this status?')) return;
            state.socket.emit('delete-status', { statusId: item._id }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not delete');
                state.statuses = state.statuses.filter(s => s._id !== item._id);
                toast('Status deleted');
                refreshOpenViewer();
                if (!$('viewer').hidden && !state.viewer.items.length) closeViewer();
            });
        }

        // Status composer

        function openStatusComposer() {
            state.composer = { bg: STATUS_BACKGROUNDS[0], image: null };
            $('sc-text').value = '';
            renderStatusComposer();
            $('composer-status').hidden = false;
        }

        function renderStatusComposer() {
            const c = state.composer;
            const box = $('sc-box');
            box.style.background = c.image ? '#000' : c.bg;
            box.style.backgroundImage = c.image ? `url("${c.image}")` : 'none';
            $('sc-swatches').innerHTML = STATUS_BACKGROUNDS.map(color => `
                <button class="swatch ${!c.image && c.bg === color ? 'on' : ''}" data-bg="${color}" style="background:${color}" aria-label="Background colour"></button>`).join('');
            $('sc-remove-photo').hidden = !c.image;
            $('sc-photo').hidden = !!c.image;
        }

        async function addStatusPhoto() {
            const file = await pickFile();
            if (!file) return;
            const data = await openEditor(file, { outMax: 1280 });
            if (!data) return;
            state.composer.image = data;
            renderStatusComposer();
        }

        function postStatus() {
            const text = $('sc-text').value.trim();
            const image = state.composer.image;
            if (!text && !image) return toast('Add some text or a photo');
            $('sc-post').disabled = true;
            state.socket.emit('add-status', { text, image, bg: state.composer.bg }, (res) => {
                $('sc-post').disabled = false;
                if (!res || !res.success) return toast(res?.error || 'Could not post status');
                $('composer-status').hidden = true;
                toast('Status posted');
                loadStatuses();
            });
        }

        // Private chat

        function openChat(partner) {
            closeChat(true);
            state.chat = { ...emptyChat(), kind: 'private', partner };
            $('chat').hidden = false;
            $('chat-title').textContent = partner;
            $('chat-sub').textContent = '';
            $('chat-avatar').innerHTML = avatarHTML(profileFor(partner), 'avatar small');
            $('chat-messages').innerHTML = '';
            applyChatStyle();
            renderComposer();
            renderOneViewBtn();

            state.socket.emit('join-conversation', { target: partner }, (res) => {
                if (state.chat.partner !== partner) return;
                if (!res || !res.success) { toast(res?.error || 'Could not open chat'); return closeChat(); }
                state.chat.profile = res.profile;
                state.chat.prefs = res.prefs || {};
                state.chat.block = res.blocked || { byMe: false, byThem: false };
                state.profiles[partner] = res.profile;
                $('chat-messages').innerHTML = res.messages.map(m => bubbleHTML(m)).join('');
                applyChatStyle();
                renderChatHeader();
                renderComposer();
                scrollBottom();
                scheduleConversations();
            });
        }

        function closeChat(silent = false) {
            if (state.voice.recorder) stopVoice(true);
            clearTimeout(state.chat.stopTimer);
            if (state.socket && state.chat.kind) emitActivity('typing', false);
            state.chat = emptyChat();
            state.oneViewNext = false;
            state.replyTo = null;
            state.editing = null;
            $('chat').hidden = true;
            $('chat').style.removeProperty('--mine');
            $('chat').style.removeProperty('--mine-text');
            $('chat-messages').innerHTML = '';
            $('message-input').value = '';
            $('chat-sheet').hidden = true;
            closeFind();
            renderContext();
            if (!silent) loadConversations();
        }

        function renderChatHeader() {
            if (state.chat.kind === 'group') {
                const g = state.chat.group;
                if (!g) return;
                $('chat-title').textContent = g.name;
                $('chat-avatar').innerHTML = groupAvatarHTML(g, 'avatar small');
                const act = activityForGroup(g._id);
                const sub = $('chat-sub');
                if (act) { sub.textContent = `${nameOf(act.who)} is ${activityText(act.kind)}`; sub.className = 'activity'; }
                else {
                    const online = g.members.filter(m => m !== state.user && profileFor(m).online).length;
                    sub.textContent = `${plural(g.members.length, 'member')}${online ? ` · ${online} online` : ''}`;
                    sub.className = '';
                }
                return;
            }
            const partner = state.chat.partner;
            if (!partner) return;
            const p = state.chat.profile || profileFor(partner);
            $('chat-title').textContent = p.displayName || p.username;
            $('chat-avatar').innerHTML = avatarHTML(p, 'avatar small');
            const act = activityForUser(partner);
            const sub = $('chat-sub');
            if (act) { sub.textContent = activityText(act); sub.className = 'activity'; }
            else if (p.online) { sub.textContent = 'online'; sub.className = ''; }
            else if (p.lastSeen) { sub.textContent = 'last seen ' + formatLastSeen(p.lastSeen); sub.className = ''; }
            else { sub.textContent = ''; sub.className = ''; }
        }

        function refreshPartner(username) {
            state.socket.emit('get-profile', { username }, (res) => {
                if (!res || !res.success || state.chat.partner !== username) return;
                state.chat.profile = res.profile;
                state.profiles[username] = res.profile;
                renderChatHeader();
            });
        }

        function renderComposer() {
            const bar = $('blocked-bar');
            const row = $('compose-row');
            const chat = state.chat;
            if (chat.kind === 'group') {
                const g = chat.group;
                if (g && !g.canSend) {
                    bar.hidden = false;
                    bar.innerHTML = '<span>Only admins can send messages in this group.</span>';
                    row.hidden = true;
                } else {
                    bar.hidden = true;
                    bar.innerHTML = '';
                    row.hidden = false;
                }
                $('oneview-btn').hidden = true;
                updateActionButton();
                return;
            }
            $('oneview-btn').hidden = false;
            const b = chat.block;
            if (b.byMe) {
                bar.hidden = false;
                bar.innerHTML = `<span>You blocked this contact.</span><button class="btn small primary" id="unblock-chat">Unblock</button>`;
                row.hidden = true;
            } else if (b.byThem) {
                bar.hidden = false;
                bar.innerHTML = `<span>You can't send messages to this contact.</span>`;
                row.hidden = true;
            } else {
                bar.hidden = true;
                bar.innerHTML = '';
                row.hidden = false;
            }
            updateActionButton();
        }

        function renderContext() {
            const bar = $('context-bar');
            if (state.editing) {
                bar.hidden = false;
                $('context-text').innerHTML = `<b>Editing message</b>${esc(state.editing.text || '')}`;
            } else if (state.replyTo) {
                bar.hidden = false;
                const m = state.replyTo;
                const snippet = m.text || (m.image ? 'Photo' : (m.audio ? 'Voice message' : ''));
                $('context-text').innerHTML = `<b>${esc(nameOf(m.sender))}</b>${esc(snippet)}`;
            } else {
                bar.hidden = true;
            }
        }

        function renderOneViewBtn() { $('oneview-btn').classList.toggle('on', state.oneViewNext); }

        function updateActionButton() {
            const hasText = $('message-input').value.trim().length > 0;
            $('action-btn').innerHTML = hasText || state.editing ? '<i class="fa-solid fa-paper-plane"></i>' : '<i class="fa-solid fa-microphone"></i>';
            $('action-btn').dataset.mode = hasText || state.editing ? 'send' : 'mic';
        }

        function ticksFor(m) {
            if (m.read) return '<span class="ticks read" data-ticks><i class="fa-solid fa-check-double"></i></span>';
            if (m.delivered) return '<span class="ticks" data-ticks><i class="fa-solid fa-check-double"></i></span>';
            return '<span class="ticks" data-ticks><i class="fa-solid fa-check"></i></span>';
        }

        function oneViewBody(m, mine) {
            if (m.opened) return '<div class="oneview opened"><i class="fa-regular fa-eye"></i><span>Opened</span></div>';
            if (mine) return '<div class="oneview"><i class="fa-solid fa-camera"></i><span>Photo</span></div>';
            return `<div class="oneview" data-open-one="${esc(m._id)}"><i class="fa-solid fa-camera"></i><span>Photo</span></div>`;
        }

        function quoteHTML(q) {
            const label = q.kind === 'photo' ? 'Photo' : (q.kind === 'voice' ? 'Voice message' : q.text);
            return `<div class="quote" data-jump="${esc(q._id)}"><b>${esc(nameOf(q.sender))}</b><span>${esc(label)}</span></div>`;
        }

        function reactionsHTML(reactions) {
            const counts = {};
            Object.values(reactions || {}).forEach(e => { counts[e] = (counts[e] || 0) + 1; });
            const keys = Object.keys(counts);
            if (!keys.length) return '';
            return `<div class="reactions">${keys.map(e => `<span class="rx">${e}${counts[e] > 1 ? ' ' + counts[e] : ''}</span>`).join('')}</div>`;
        }

        function bubbleHTML(m, tempId = null) {
            const mine = m.sender === state.user;
            if (m.system) return `<div class="system-note" ${m._id ? `data-id="${esc(m._id)}"` : ''}>${esc(m.text)}</div>`;

            if (m._id) state.messageIndex.set(String(m._id), m);
            const isGroup = !!m.groupId;
            const classes = ['bubble', mine ? 'mine' : 'theirs'];
            if (tempId) classes.push('pending');
            if (m.deleted) classes.push('deleted');

            let body = '';
            if (m.deleted) {
                body = '<div class="deleted-note"><i class="fa-solid fa-ban"></i> This message was deleted</div>';
            } else {
                if (m.replyTo) body += quoteHTML(m.replyTo);
                if (isGroup && !mine) body += `<div class="bubble-sender">${esc(nameOf(m.sender))}</div>`;
                if (m.forwarded) body += `<div class="fwd"><i class="fa-solid fa-share"></i> Forwarded</div>`;
                if (m.oneView) {
                    body += oneViewBody(m, mine);
                } else {
                    if (m.image) body += `<img class="bubble-img" src="${esc(m.image)}" alt="Photo" data-lightbox="1">`;
                    if (m.audio) body += `<audio class="bubble-audio" controls preload="metadata" src="${esc(m.audio)}"></audio>`;
                    if (m.text) body += `<div class="bubble-text">${esc(m.text)}</div>`;
                }
            }

            const showTicks = mine && !m.deleted && !isGroup;
            const edited = m.edited && !m.deleted ? '<span>edited</span>' : '';
            const meta = `<div class="bubble-meta">${edited}<span>${fmtTime(m.timestamp)}</span>${showTicks ? ticksFor(m) : ''}</div>`;
            const idAttr = m._id ? `data-id="${esc(m._id)}"` : '';
            const tempAttr = tempId ? `data-temp="${esc(tempId)}"` : '';
            const reactions = m.deleted ? '' : reactionsHTML(m.reactions);
            return `<div class="${classes.join(' ')}" ${idAttr} ${tempAttr}>${body}${reactions}${meta}</div>`;
        }

        function scrollBottom() {
            const c = $('chat-messages');
            c.scrollTop = c.scrollHeight;
        }

        function scrollToMessage(id) {
            const el = $('chat-messages').querySelector(`[data-id="${cssEsc(id)}"]`);
            if (!el) return toast('That message is not in view');
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('hit', 'current');
            setTimeout(() => el.classList.remove('current'), 1200);
        }

        function sendMessage(payload) {
            const chat = state.chat;
            const isGroup = chat.kind === 'group';
            if (isGroup ? !chat.groupId : !chat.partner) return;

            const tempId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
            const replyTo = state.replyTo ? replyPayload(state.replyTo) : null;
            const local = {
                sender: state.user, receiver: chat.partner, groupId: isGroup ? chat.groupId : null,
                text: payload.text || '', image: payload.oneView ? null : (payload.image || null),
                audio: payload.audio || null, audioDuration: payload.audioDuration || 0,
                oneView: !!payload.oneView, opened: false, forwarded: !!payload.forwarded,
                replyTo, timestamp: new Date(), read: false, delivered: false, deleted: false, reactions: {}
            };
            $('chat-messages').insertAdjacentHTML('beforeend', bubbleHTML(local, tempId));
            scrollBottom();

            const event = isGroup ? 'send-group-message' : 'send-private-message';
            const body = isGroup
                ? { groupId: chat.groupId, tempId, ...payload, oneView: undefined, replyTo }
                : { receiver: chat.partner, tempId, ...payload, replyTo };

            state.replyTo = null;
            renderContext();

            state.socket.emit(event, body, (res) => {
                if (!res || !res.success) {
                    const el = $('chat-messages').querySelector(`[data-temp="${cssEsc(tempId)}"]`);
                    if (el) el.classList.add('failed');
                    return toast(res?.error || 'Message not sent');
                }
                applySaved(tempId, res.message);
                scheduleConversations();
            });
        }

        function replyPayload(m) {
            const kind = m.image ? 'photo' : (m.audio ? 'voice' : 'text');
            return { _id: String(m._id), sender: m.sender, text: m.text || '', kind };
        }

        function sendText() {
            const input = $('message-input');
            const text = input.value.trim();
            const chat = state.chat;
            if (!text && !state.editing) return;
            if (chat.kind === 'private' && !chat.partner) return;
            if (chat.kind === 'group' && !chat.groupId) return;

            if (state.editing) {
                const id = state.editing._id;
                state.socket.emit('edit-message', { messageId: id, text }, (res) => {
                    if (!res || !res.success) toast(res?.error || 'Could not edit');
                });
                state.editing = null;
                input.value = '';
                renderContext();
                updateActionButton();
                return;
            }

            input.value = '';
            updateActionButton();
            clearTimeout(chat.stopTimer);
            emitActivity('typing', false);
            sendMessage({ text });
        }

        function applySaved(tempId, message) {
            const container = $('chat-messages');
            const pending = tempId ? container.querySelector(`[data-temp="${cssEsc(tempId)}"]`) : null;
            if (pending) {
                pending.dataset.id = message._id;
                delete pending.dataset.temp;
                pending.classList.remove('pending');
                state.messageIndex.set(String(message._id), message);
                const meta = pending.querySelector('.bubble-meta');
                if (meta && !meta.querySelector('.ticks') && message.groupId === undefined) {
                    // ticks already rendered by bubbleHTML for private sends
                }
                return;
            }
            const chat = state.chat;
            const inThisChat = chat.kind === 'private' && chat.partner && (message.sender === chat.partner || message.receiver === chat.partner);
            if (inThisChat && !container.querySelector(`[data-id="${cssEsc(message._id)}"]`)) {
                container.insertAdjacentHTML('beforeend', bubbleHTML(message));
                scrollBottom();
            }
        }

        function setTicks(id, kind) {
            const bubble = $('chat-messages').querySelector(`[data-id="${cssEsc(id)}"]`);
            if (!bubble) return;
            const ticks = bubble.querySelector('[data-ticks]');
            if (!ticks) return;
            ticks.outerHTML = ticksFor(kind === 'read' ? { read: true } : { delivered: true });
        }

        function onIncoming(msg) {
            if (state.chat.kind === 'private' && state.chat.partner === msg.sender) {
                const exists = $('chat-messages').querySelector(`[data-id="${cssEsc(msg._id)}"]`);
                if (!exists) {
                    $('chat-messages').insertAdjacentHTML('beforeend', bubbleHTML(msg));
                    scrollBottom();
                }
                state.socket.emit('mark-read', { partner: msg.sender });
            } else {
                const s = S();
                if (s.sound && !s.mutedChats.includes(msg.sender)) playBeep();
                const body = msg.oneView ? 'Photo' : (msg.audio ? 'Voice message' : (msg.image ? 'Photo' : msg.text));
                if (s.notifications && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
                    new Notification(`New message from ${msg.sender}`, { body });
                } else {
                    toast(`${msg.sender}: ${body}`);
                }
            }
            scheduleConversations();
        }

        function onMessageDeleted({ messageId }) {
            const m = state.messageIndex.get(String(messageId));
            if (m) m.deleted = true;
            const bubble = $('chat-messages').querySelector(`[data-id="${cssEsc(messageId)}"]`);
            if (bubble) {
                bubble.classList.add('deleted');
                bubble.innerHTML = `<div class="deleted-note"><i class="fa-solid fa-ban"></i> This message was deleted</div>
                    <div class="bubble-meta"><span>${fmtTime(new Date())}</span></div>`;
            }
            scheduleConversations();
        }

        function renderOpenedBubble(messageId) {
            const bubble = $('chat-messages').querySelector(`[data-id="${cssEsc(messageId)}"]`);
            if (!bubble) return;
            const body = bubble.querySelector('.oneview');
            if (body) body.outerHTML = '<div class="oneview opened"><i class="fa-regular fa-eye"></i><span>Opened</span></div>';
        }

        function openOneView(messageId) {
            state.socket.emit('open-one-view', { messageId }, (res) => {
                if (!res || !res.success) { renderOpenedBubble(messageId); return toast(res?.error || 'Could not open photo'); }
                renderOpenedBubble(messageId);
                openLightbox(res.image);
            });
        }

        function onChatCleared({ partner }) {
            if (state.chat.partner === partner) $('chat-messages').innerHTML = '';
            loadConversations();
        }

        function onPresence({ username }) {
            if (state.conversations.some(c => c.partner === username)) scheduleConversations();
            if (state.tab === 'contacts') loadContacts();
            if (state.chat.kind === 'private' && state.chat.partner === username) refreshPartner(username);
            if (state.chat.kind === 'group') renderChatHeader();
        }

        function onProfileUpdated() {
            scheduleConversations();
            loadStatuses();
            if (state.chat.kind === 'private' && state.chat.partner) refreshPartner(state.chat.partner);
        }

        function deleteMessage(messageId) {
            if (!confirm('Delete this message for everyone?')) return;
            if (state.chat.kind === 'group') {
                state.socket.emit('delete-group-message', { messageId }, (res) => { if (!res || !res.success) toast(res?.error || 'Could not delete'); });
                return;
            }
            state.socket.emit('delete-message', { messageId }, (res) => { if (!res || !res.success) toast(res?.error || 'Could not delete'); });
        }

        // Long press a message: react, reply, copy, forward, star, edit, delete

        function openMsgSheet(id) {
            const m = state.messageIndex.get(String(id));
            if (!m || m.system) return;
            state.menuMsg = m;
            const mine = m.sender === state.user;
            const isGroup = !!m.groupId;
            const canDelete = !m.deleted && (mine || (isGroup && state.chat.group?.isAdmin));
            const canEdit = mine && !m.deleted && !m.image && !m.audio && !m.oneView && !!m.text;
            const starred = state.starredIds.has(String(m._id));
            const myReaction = (m.reactions || {})[state.user];

            $('msg-sheet-body').innerHTML = `
                <div class="sheet-grip"></div>
                ${m.deleted ? '' : `
                <div class="react-row">
                    ${REACTIONS.map(e => `<button data-react="${e}" class="${myReaction === e ? 'on' : ''}">${e}</button>`).join('')}
                </div>`}
                ${m.deleted ? '' : `<button data-msg="reply"><i class="fa-solid fa-reply" style="width:24px;color:var(--accent)"></i>&nbsp; Reply</button>`}
                ${m.text && !m.deleted ? `<button data-msg="copy"><i class="fa-regular fa-copy" style="width:24px;color:var(--accent)"></i>&nbsp; Copy</button>` : ''}
                ${!m.deleted && !m.oneView ? `<button data-msg="forward"><i class="fa-solid fa-share" style="width:24px;color:var(--accent)"></i>&nbsp; Forward</button>` : ''}
                ${!m.deleted ? `<button data-msg="star"><i class="fa-${starred ? 'solid' : 'regular'} fa-star" style="width:24px;color:#EAB308"></i>&nbsp; ${starred ? 'Unstar' : 'Star'}</button>` : ''}
                ${canEdit ? `<button data-msg="edit"><i class="fa-solid fa-pen" style="width:24px;color:var(--accent)"></i>&nbsp; Edit</button>` : ''}
                ${!mine && !m.deleted ? `<button data-msg="report" class="danger-text"><i class="fa-solid fa-flag" style="width:24px"></i>&nbsp; Report</button>` : ''}
                ${canDelete ? `<button data-msg="delete" class="danger-text"><i class="fa-solid fa-trash-can" style="width:24px"></i>&nbsp; Delete</button>` : ''}
                <button data-msg="close">Cancel</button>`;
            $('msg-sheet').hidden = false;
        }

        function runMsgAction(action, extra) {
            const m = state.menuMsg;
            $('msg-sheet').hidden = true;
            if (!m) return;

            if (action === 'react') {
                const current = (m.reactions || {})[state.user];
                const emoji = current === extra ? null : extra;
                state.socket.emit('react-message', { messageId: m._id, emoji }, (res) => {
                    if (!res || !res.success) toast(res?.error || 'Could not react');
                });
            }
            if (action === 'reply') {
                state.replyTo = m;
                state.editing = null;
                renderContext();
                $('message-input').focus();
            }
            if (action === 'copy') {
                if (navigator.clipboard) navigator.clipboard.writeText(m.text || '').then(() => toast('Copied'));
                else toast('Copy is not available here');
            }
            if (action === 'forward') {
                state.fwdMessage = m;
                openPage('forward');
            }
            if (action === 'star') {
                const on = !state.starredIds.has(String(m._id));
                state.socket.emit('star-message', { messageId: m._id, on }, (res) => {
                    if (!res || !res.success) return toast(res?.error || 'Could not update');
                    if (on) state.starredIds.add(String(m._id)); else state.starredIds.delete(String(m._id));
                    toast(on ? 'Starred' : 'Unstarred');
                });
            }
            if (action === 'edit') {
                state.editing = m;
                state.replyTo = null;
                $('message-input').value = m.text || '';
                renderContext();
                updateActionButton();
                $('message-input').focus();
            }
            if (action === 'delete') deleteMessage(m._id);
            if (action === 'report') openReport('message', m._id);
        }

        // Forward picker

        function pageForward() {
            const m = state.fwdMessage;
            if (!m) return '<div class="empty">Nothing to forward.</div>';
            const people = state.contacts;
            return `
                <div class="section-title">Chats</div>
                <div class="list-card">
                    ${state.groups.map(g => `
                        <label class="check-row">
                            <input type="checkbox" data-fwd="g:${esc(g._id)}">
                            ${groupAvatarHTML(g, 'avatar small')}
                            <div class="row-main"><div class="row-title">${esc(g.name)}</div><div class="row-sub">Group</div></div>
                        </label>`).join('')}
                    ${people.map(p => `
                        <label class="check-row">
                            <input type="checkbox" data-fwd="u:${esc(p.username)}">
                            ${avatarHTML(p, 'avatar small')}
                            <div class="row-main"><div class="row-title">${esc(p.displayName || p.username)}</div><div class="row-sub">@${esc(p.username)}</div></div>
                        </label>`).join('')}
                </div>`;
        }

        function sendForward() {
            const m = state.fwdMessage;
            const targets = [...document.querySelectorAll('[data-fwd]:checked')].map(i => i.dataset.fwd);
            if (!m || !targets.length) return toast('Choose at least one chat');

            let payload;
            if (m.image) payload = { image: m.image };
            else if (m.audio) payload = { audio: m.audio, audioDuration: m.audioDuration || 0 };
            else payload = { text: m.text || '' };
            payload.forwarded = true;

            for (const t of targets) {
                const [kind, id] = [t.slice(0, 1), t.slice(2)];
                if (kind === 'g') state.socket.emit('send-group-message', { groupId: id, ...payload }, () => {});
                else state.socket.emit('send-private-message', { receiver: id, ...payload }, () => {});
            }
            toast(`Forwarded to ${plural(targets.length, 'chat')}`);
            state.fwdMessage = null;
            closeAllPages();
            loadConversations();
        }

        // Chat search

        function openFind() {
            $('find-bar').hidden = false;
            $('find-input').value = '';
            $('find-input').focus();
            runFind();
        }

        function closeFind() {
            $('find-bar').hidden = true;
            $('chat-messages').querySelectorAll('.hit, .current').forEach(el => el.classList.remove('hit', 'current'));
            state.hits = [];
            state.hitIndex = -1;
            $('find-count').textContent = '';
        }

        function runFind() {
            const q = $('find-input').value.trim().toLowerCase();
            $('chat-messages').querySelectorAll('.hit, .current').forEach(el => el.classList.remove('hit', 'current'));
            state.hits = [];
            state.hitIndex = -1;
            if (q) {
                state.hits = [...$('chat-messages').querySelectorAll('.bubble[data-id]')].filter(el => el.textContent.toLowerCase().includes(q));
                state.hits.forEach(el => el.classList.add('hit'));
            }
            if (state.hits.length) jumpHit(1);
            else $('find-count').textContent = q ? '0 found' : '';
        }

        function jumpHit(dir) {
            if (!state.hits.length) return;
            state.hits.forEach(el => el.classList.remove('current'));
            state.hitIndex = (state.hitIndex + dir + state.hits.length) % state.hits.length;
            const el = state.hits[state.hitIndex];
            el.classList.add('current');
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            $('find-count').textContent = `${state.hitIndex + 1} of ${state.hits.length}`;
        }

        // Photos and one-view

        async function attachPhoto() {
            const chat = state.chat;
            if ((chat.kind === 'private' && !chat.partner) || (chat.kind === 'group' && !chat.groupId)) return;
            const file = await pickFile();
            if (!file) return;
            const image = await openEditor(file, { outMax: 1280 });
            if (!image) return;
            const mode = await askSendMode(chat.kind === 'private');
            if (!mode) return;
            sendMessage(mode === 'once' ? { image, oneView: true } : { image });
        }

        function askSendMode(allowOnce) {
            return new Promise((resolve) => {
                const sheet = $('send-sheet');
                $('send-once-btn').hidden = !allowOnce;
                sheet.hidden = false;
                sheet.onclick = (e) => {
                    const b = e.target.closest('[data-send]');
                    if (e.target !== sheet && !b) return;
                    sheet.hidden = true;
                    sheet.onclick = null;
                    const choice = b ? b.dataset.send : 'cancel';
                    resolve(choice === 'cancel' ? null : choice);
                };
            });
        }

        const EMOJIS = ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','😉','😍','🥰','😘','😋','😎','🤩','🥳','😏','😒','😞','😔','😢','😭','😤','😠','😡','🤔','🤗','🙄','😴','🤯','😱','😳','🥺','😬','🤝','👍','👎','👏','🙏','💪','🙌','👌','✌️','🤞','👋','❤️','🧡','💛','💚','💙','💜','🖤','💔','🔥','✨','🎉','💯','✅','❌','⭐','🌟','☕','🍕','🎂','🚗','🏠','📍'];

        function openEmojiSheet() {
            const grid = $('emoji-grid');
            if (!grid.children.length) {
                grid.innerHTML = EMOJIS.map(e => `<button data-emoji-pick="${e}">${e}</button>`).join('');
            }
            $('emoji-sheet').hidden = false;
        }

        function pickEmoji(emoji) {
            const input = $('message-input');
            input.value += emoji;
            input.focus();
            updateActionButton();
        }

        function toggleOneView() {
            state.oneViewNext = !state.oneViewNext;
            renderOneViewBtn();
            toast(state.oneViewNext ? 'Next photo will disappear after it is viewed once' : 'One-view turned off');
        }

        function openLightbox(src) { $('lightbox-img').src = src; $('lightbox').hidden = false; }
        function closeLightbox() { $('lightbox').hidden = true; $('lightbox-img').removeAttribute('src'); }

        // Voice notes

        async function startVoice() {
            const chat = state.chat;
            if (chat.kind === 'private' && (!chat.partner || chat.block.byMe || chat.block.byThem)) return;
            if (chat.kind === 'group' && (!chat.groupId || (chat.group && !chat.group.canSend))) return;
            if (!navigator.mediaDevices || !window.MediaRecorder) return toast('Voice notes are not supported in this browser');

            let stream;
            try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
            catch (err) { return toast('Allow microphone access to record voice notes'); }

            const v = state.voice;
            const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t));
            v.stream = stream;
            v.chunks = [];
            v.discard = false;
            v.recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
            v.recorder.ondataavailable = (e) => { if (e.data && e.data.size) v.chunks.push(e.data); };
            v.recorder.onstop = finishVoice;
            v.startedAt = Date.now();
            v.recorder.start();

            emitActivity('recording', true);
            $('compose-row').hidden = true;
            $('rec-bar').hidden = false;
            tickVoice();
            v.timer = setInterval(tickVoice, 200);
        }

        function tickVoice() {
            const elapsed = (Date.now() - state.voice.startedAt) / 1000;
            $('rec-time').textContent = fmtDuration(elapsed);
            if (elapsed >= MAX_VOICE_SECONDS) stopVoice(false);
        }

        function stopVoice(discard) {
            const v = state.voice;
            v.discard = discard;
            clearInterval(v.timer);
            if (v.recorder && v.recorder.state !== 'inactive') v.recorder.stop();
        }

        async function finishVoice() {
            const v = state.voice;
            clearInterval(v.timer);
            emitActivity('recording', false);
            const duration = Math.max(1, Math.round((Date.now() - v.startedAt) / 1000));
            const type = ((v.recorder && v.recorder.mimeType) || 'audio/webm').split(';')[0];
            const blob = new Blob(v.chunks, { type });
            if (v.stream) v.stream.getTracks().forEach(t => t.stop());
            v.stream = null; v.recorder = null; v.chunks = [];
            $('rec-bar').hidden = true;
            $('compose-row').hidden = false;
            if (v.discard || !blob.size) return;
            if (state.chat.kind === 'private' && !state.chat.partner) return;
            if (state.chat.kind === 'group' && !state.chat.groupId) return;
            const dataUrl = await blobToDataUrl(blob);
            if (dataUrl.length > AUDIO_LIMIT) return toast('That voice note is too long to send');
            sendMessage({ audio: dataUrl, audioDuration: duration });
        }

        function unblockFromChat() {
            const partner = state.chat.partner;
            if (!partner) return;
            unblockUser(partner, () => { state.chat.block.byMe = false; renderComposer(); });
        }

        // Chat options sheet

        function openChatSheet() {
            const chat = state.chat;
            const s = S();
            let buttons;
            if (chat.kind === 'group') {
                const g = chat.group;
                const muted = s.mutedChats.includes('group:' + chat.groupId);
                buttons = `
                    <div class="sheet-grip"></div>
                    <button data-sheet="group-info"><i class="fa-solid fa-circle-info" style="width:24px;color:var(--accent)"></i>&nbsp; Group info</button>
                    <button data-sheet="find"><i class="fa-solid fa-magnifying-glass" style="width:24px;color:var(--accent)"></i>&nbsp; Search in chat</button>
                    <button data-sheet="media"><i class="fa-solid fa-photo-film" style="width:24px;color:var(--accent)"></i>&nbsp; Media</button>
                    <button data-sheet="mute"><i class="fa-solid fa-bell-slash" style="width:24px;color:var(--accent)"></i>&nbsp; ${muted ? 'Unmute notifications' : 'Mute notifications'}</button>
                    <button data-sheet="group-clear"><i class="fa-solid fa-broom" style="width:24px;color:var(--accent)"></i>&nbsp; Clear chat</button>
                    <button data-sheet="group-exit" class="danger-text">Exit group</button>
                    ${g && g.isAdmin ? '<button data-sheet="group-delete" class="danger-text">Delete group</button>' : ''}
                    <button data-sheet="close">Cancel</button>`;
            } else {
                const p = chat.prefs || {};
                buttons = `
                    <div class="sheet-grip"></div>
                    <button data-sheet="profile"><i class="fa-solid fa-user" style="width:24px;color:var(--accent)"></i>&nbsp; View profile</button>
                    <button data-sheet="find"><i class="fa-solid fa-magnifying-glass" style="width:24px;color:var(--accent)"></i>&nbsp; Search in chat</button>
                    <button data-sheet="media"><i class="fa-solid fa-photo-film" style="width:24px;color:var(--accent)"></i>&nbsp; Media</button>
                    <button data-sheet="pin"><i class="fa-solid fa-thumbtack" style="width:24px;color:var(--accent)"></i>&nbsp; ${p.pinned ? 'Unpin chat' : 'Pin chat'}</button>
                    <button data-sheet="archive"><i class="fa-solid fa-box-archive" style="width:24px;color:var(--accent)"></i>&nbsp; ${p.archived ? 'Unarchive chat' : 'Archive chat'}</button>
                    <button data-sheet="style"><i class="fa-solid fa-palette" style="width:24px;color:var(--accent)"></i>&nbsp; Chat colour and wallpaper</button>
                    <button data-sheet="mute"><i class="fa-solid fa-bell-slash" style="width:24px;color:var(--accent)"></i>&nbsp; ${s.mutedChats.includes(chat.partner) ? 'Unmute notifications' : 'Mute notifications'}</button>
                    <button data-sheet="clear"><i class="fa-solid fa-broom" style="width:24px;color:var(--accent)"></i>&nbsp; Clear chat</button>
                    <button data-sheet="block" class="danger-text">${s.blockedUsers.includes(chat.partner) ? 'Unblock' : 'Block'}</button>
                    <button data-sheet="close">Cancel</button>`;
            }
            $('chat-sheet-body').innerHTML = buttons;
            $('chat-sheet').hidden = false;
        }

        function runSheetAction(action) {
            const chat = state.chat;
            $('chat-sheet').hidden = true;
            if (action === 'close') return;

            if (action === 'find') return openFind();
            if (action === 'media') {
                return chat.kind === 'group'
                    ? openMedia({ groupId: chat.groupId })
                    : openMedia({ target: chat.partner });
            }

            if (chat.kind === 'group') {
                if (action === 'group-info') return openGroupInfo();
                if (action === 'mute') {
                    const key = 'group:' + chat.groupId;
                    const list = S().mutedChats;
                    const next = list.includes(key) ? list.filter(u => u !== key) : [...list, key];
                    return saveSettings({ mutedChats: next }, next.includes(key) ? 'Group muted' : 'Group unmuted');
                }
                if (action === 'group-clear') return clearGroupChat();
                if (action === 'group-exit') return exitGroup();
                if (action === 'group-delete') return deleteGroup();
                return;
            }

            const partner = chat.partner;
            if (!partner) return;
            if (action === 'profile') return openUserProfile(partner);
            if (action === 'pin') {
                const pinned = !!chat.prefs?.pinned;
                setPrefsFor(partner, { pinned: !pinned }, pinned ? 'Chat unpinned' : 'Chat pinned');
            }
            if (action === 'archive') {
                const archiving = !chat.prefs?.archived;
                setPrefsFor(partner, { archived: archiving }, archiving ? 'Chat archived' : 'Chat unarchived');
                if (archiving) closeChat();
            }
            if (action === 'style') openPage('chatstyle');
            if (action === 'mute') {
                const list = S().mutedChats;
                const next = list.includes(partner) ? list.filter(u => u !== partner) : [...list, partner];
                saveSettings({ mutedChats: next }, next.includes(partner) ? 'Chat muted' : 'Chat unmuted');
            }
            if (action === 'clear') {
                if (!confirm('Clear this chat on your side?')) return;
                state.socket.emit('clear-chat', { target: partner }, (res) => { if (!res || !res.success) toast(res?.error || 'Could not clear chat'); });
            }
            if (action === 'block') {
                const isBlocked = S().blockedUsers.includes(partner);
                if (isBlocked) unblockUser(partner, () => { chat.block.byMe = false; renderComposer(); });
                else {
                    if (!confirm(`Block ${partner}? You won't receive their messages.`)) return;
                    blockUser(partner, () => { chat.block.byMe = true; renderComposer(); });
                }
            }
        }

        // Settings menu and generic pages

        function menuRow(icon, title, sub, page) {
            return `
                <button class="menu-row" data-page="${page}">
                    <span class="menu-ico"><i class="fa-solid ${icon}"></i></span>
                    <span class="menu-text">${esc(title)}${sub ? `<div class="menu-sub">${esc(sub)}</div>` : ''}</span>
                    <i class="fa-solid fa-chevron-right" style="color:var(--muted)"></i>
                </button>`;
        }

        function switchRow(title, sub, key, checked) {
            return `
                <label class="list-row">
                    <div class="row-main"><div class="row-title">${esc(title)}</div>${sub ? `<div class="hint">${esc(sub)}</div>` : ''}</div>
                    <span class="switch"><input type="checkbox" data-setting="${esc(key)}" ${checked ? 'checked' : ''}><span class="track"></span></span>
                </label>`;
        }

        function selectRow(title, key, value) {
            const options = [['everyone', 'Everyone'], ['contacts', 'People I chat with'], ['nobody', 'Nobody']];
            return `
                <div class="list-row">
                    <div class="row-title">${esc(title)}</div>
                    <select class="field" data-setting="${esc(key)}">
                        ${options.map(([v, label]) => `<option value="${v}" ${value === v ? 'selected' : ''}>${label}</option>`).join('')}
                    </select>
                </div>`;
        }

        const PAGES = {
            settings: { title: 'Settings', html: pageSettings },
            account: { title: 'Account', html: pageAccount },
            privacy: { title: 'Privacy', html: pagePrivacy },
            chats: { title: 'Chat settings', html: pageChats },
            notifications: { title: 'Notifications', html: pageNotifications },
            blocked: { title: 'Blocked contacts', html: pageBlocked },
            chatstyle: { title: 'Chat colour and wallpaper', html: pageChatStyle },
            newgroup: { title: 'New group', html: pageNewGroup, actions: '<button class="btn primary small" data-action="create-group">Create</button>' },
            groupinfo: { title: 'Group info', html: pageGroupInfo },
            addmembers: { title: 'Add members', html: pageAddMembers, actions: '' },
            userprofile: { title: 'Chat info', html: pageUserProfile },
            media: { title: 'Media', html: pageMedia },
            starred: { title: 'Starred messages', html: pageStarred },
            explore: { title: 'Explore channels', html: pageExplore },
            newchannel: { title: 'New channel', html: pageNewChannel },
            channelinfo: { title: 'Channel info', html: pageChannelInfo },
            forward: { title: 'Forward to', html: pageForward, actions: '<button class="btn primary small" data-action="fwd-send">Send</button>' }
        };

        function openPage(name, data) {
            if (name === 'groupinfo' && data && data.groupId) {
                state.pageData.group = null;
                loadGroupInfo(data.groupId);
            }
            if (name === 'addmembers') { /* uses the loaded group */ }
            if (name === 'userprofile' && data && data.username) {
                state.pageData.profile = null;
                loadUserProfile(data.username);
            }
            if (name === 'media') {
                state.pageData.media = null;
                loadMedia(data || {});
            }
            if (name === 'starred') {
                state.pageData.starred = null;
                loadStarred();
            }
            if (name === 'channelinfo' && data && data.channelId) {
                state.pageData.channel = null;
                loadChannelInfo(data.channelId);
            }
            if (name === 'explore') loadExplore('');
            if (name === 'forward' || name === 'newgroup' || name === 'addmembers') loadContacts();
            state.pages.push(name);
            $('page').hidden = false;
            renderPage();
        }

        function renderPage() {
            const name = state.pages[state.pages.length - 1];
            const def = PAGES[name];
            if (!def) return;
            $('page-title').textContent = def.title;
            $('page-actions').innerHTML = def.actions || '';
            $('page-body').innerHTML = def.html();
            $('page-body').scrollTop = 0;
        }

        function backPage() {
            state.pages.pop();
            if (!state.pages.length) closeAllPages();
            else renderPage();
        }

        function closeAllPages() {
            state.pages = [];
            state.pageData = {};
            $('page').hidden = true;
            $('page-body').innerHTML = '';
            $('page-actions').innerHTML = '';
        }

        function pageSettings() {
            const s = S();
            return `
                <div class="profile-card" data-page="account">
                    ${avatarHTML(selfProfile(), 'avatar xl')}
                    <div class="pc-name">${esc(s.displayName || state.user)}</div>
                    <div class="pc-user">@${esc(state.user)}</div>
                    <div class="pc-about">${esc(s.about || '')}</div>
                </div>
                <div class="menu-list">
                    ${menuRow('fa-user', 'Account', 'Name, about, profile photo', 'account')}
                    ${menuRow('fa-lock', 'Privacy', 'Last seen, photo, read receipts', 'privacy')}
                    ${menuRow('fa-palette', 'Chats', 'Theme, wallpaper, archived chats', 'chats')}
                    ${menuRow('fa-bell', 'Notifications', 'Messages and sounds', 'notifications')}
                    ${menuRow('fa-star', 'Starred messages', 'Messages you saved', 'starred')}
                    ${menuRow('fa-user-slash', 'Blocked contacts', s.blockedUsers.length ? `${s.blockedUsers.length} blocked` : 'None', 'blocked')}
                </div>
                <div class="menu-list">
                    <button class="menu-row danger" data-action="logout">
                        <span class="menu-ico"><i class="fa-solid fa-right-from-bracket"></i></span>
                        <span class="menu-text">Log out</span>
                    </button>
                    <button class="menu-row danger" data-action="delete-account">
                        <span class="menu-ico"><i class="fa-solid fa-user-xmark"></i></span>
                        <span class="menu-text">Delete account</span>
                    </button>
                </div>`;
        }

        function pageAccount() {
            const s = S();
            return `
                <div class="profile-card">
                    <button class="avatar-btn" data-action="change-photo" style="position:relative;background:none">
                        ${avatarHTML(selfProfile(), 'avatar xl')}
                        <span class="cam-badge"><i class="fa-solid fa-camera"></i></span>
                    </button>
                    <div class="hint">@${esc(state.user)}</div>
                </div>
                <div class="section-title">Name</div>
                <input class="field" id="acc-name" maxlength="40" value="${esc(s.displayName || '')}" placeholder="Your name">
                <div class="section-title">Bio</div>
                <textarea class="field" id="acc-about" maxlength="140" placeholder="About you">${esc(s.about || '')}</textarea>
                <div style="display:flex;gap:10px;margin-top:14px">
                    <button class="btn primary block" data-action="save-profile">Save</button>
                </div>
                <div class="section-title">Phone number</div>
                <div class="list-card">
                    <div class="list-row">
                        <div><div class="row-title">${esc(s.phone || 'Not set')}</div><div class="hint">Shown to people who share a chat or group with you</div></div>
                        <button class="btn small" data-action="change-phone">Change</button>
                    </div>
                </div>
                <div class="section-title">Photo</div>
                <div class="menu-list">
                    <button class="menu-row" data-action="remove-photo">
                        <span class="menu-ico"><i class="fa-solid fa-trash-can"></i></span>
                        <span class="menu-text">Remove profile photo</span>
                    </button>
                </div>`;
        }

        function pagePrivacy() {
            const p = S().privacy;
            return `
                <div class="section-title">Who can see my info</div>
                <div class="list-card">
                    ${selectRow('Last seen and online', 'privacy.lastSeen', p.lastSeen)}
                    ${selectRow('Profile photo', 'privacy.profilePhoto', p.profilePhoto)}
                    ${soonRow('About')}
                    <div class="list-row">
                        <div><div class="row-title">Status</div><div class="hint">Who can see your status updates</div></div>
                        <select class="field" data-setting="privacy.status">
                            <option value="contacts" ${p.status === 'everyone' ? '' : 'selected'}>My contacts</option>
                            <option value="everyone" ${p.status === 'everyone' ? 'selected' : ''}>Everyone</option>
                        </select>
                    </div>
                </div>
                <div class="section-title">Messages</div>
                <div class="list-card">
                    ${switchRow('Read receipts', 'Blue ticks show when you have read messages', 'privacy.readReceipts', p.readReceipts)}
                    ${soonRow('Disappearing messages')}
                    ${soonRow('Groups')}
                </div>`;
        }
        function localSwitch(title, sub, key, def) {
            const saved = localStorage.getItem(key);
            const on = saved === null ? def : saved === '1';
            return `<label class="list-row"><div class="row-main"><div class="row-title">${esc(title)}</div>${sub ? `<div class="hint">${esc(sub)}</div>` : ''}</div><span class="switch"><input type="checkbox" data-local="${esc(key)}" ${on ? 'checked' : ''}><span class="track"></span></span></label>`;
        }

        function soonRow(title, sub) {
            return `<div class="list-row" data-soon="1" style="cursor:pointer"><div class="row-main"><div class="row-title">${esc(title)}</div><div class="hint">${esc(sub || 'Coming soon')}</div></div><i class="fa-solid fa-chevron-right" style="color:var(--muted)"></i></div>`;
        }

        function pageChats() {
            const s = S();
            return `
                <div class="section-title">Chat settings</div>
                <div class="list-card">
                    <div class="list-row">
                        <div class="row-title">Theme</div>
                        <select class="field" data-setting="theme">
                            <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>Dark</option>
                            <option value="light" ${s.theme === 'light' ? 'selected' : ''}>Light</option>
                            <option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>System</option>
                        </select>
                    </div>
                    <div class="list-row" data-action="wall-upload" style="cursor:pointer">
                        <div class="row-main"><div class="row-title">Wallpaper</div><div class="hint">Default for all chats</div></div>
                        <i class="fa-solid fa-chevron-right" style="color:var(--muted)"></i>
                    </div>
                    ${localSwitch('Enter key sends', 'Press Enter to send a message', 'enterSends', true)}
                    ${localSwitch('Media visibility', 'Show photos in your gallery', 'mediaVisible', true)}
                    ${soonRow('Font size', 'Medium')}
                    ${soonRow('Chat backup')}
                    ${soonRow('Export chat')}
                </div>
                <div class="section-title">Archived chats</div>
                <div class="list-card">
                    ${switchRow('Keep chats archived', 'New messages will not bring archived chats back to the main list', 'keepArchived', s.keepArchived)}
                </div>`;
        }

        function pageNotifications() {
            const s = S();
            return `
                <div class="section-title">Messages</div>
                <div class="list-card">
                    ${switchRow('Message notifications', 'Show alerts for new messages', 'notifications', s.notifications)}
                    ${switchRow('Sounds', 'Play a sound for new messages', 'sound', s.sound)}
                    ${soonRow('Group notifications')}
                    ${soonRow('Call notifications')}
                    ${soonRow('Notification tone')}
                    ${soonRow('Vibrate')}
                    ${soonRow('Popup notification')}
                </div>`;
        }
        function pageBlocked() {
            const list = S().blockedUsers;
            if (!list.length) return '<div class="empty">You have not blocked anyone.</div>';
            return `<div class="list-card">${list.map(u => `
                <div class="unblock-row">
                    ${avatarHTML(profileFor(u), 'avatar small')}
                    <div class="row-main"><div class="row-title">${esc(profileFor(u).displayName || u)}</div></div>
                    <button class="btn small" data-action="unblock" data-user="${esc(u)}">Unblock</button>
                </div>`).join('')}</div>`;
        }

        function pageChatStyle() {
            const p = state.chat.prefs || {};
            if (state.chat.kind !== 'private' || !state.chat.partner) return '<div class="empty">Open a private chat first.</div>';
            return `
                <div class="section-title">Bubble colour</div>
                <div class="list-card" style="padding:6px 14px 14px">
                    <div class="swatches">
                        <button class="swatch ${!p.color ? 'on' : ''}" data-chat-color="" style="background:var(--surface-3)" aria-label="Default colour"></button>
                        ${BUBBLE_COLORS.map(c => `<button class="swatch ${p.color === c ? 'on' : ''}" data-chat-color="${c}" style="background:${c}" aria-label="Colour"></button>`).join('')}
                    </div>
                    <div class="hint">Only you see this colour in this chat.</div>
                </div>
                <div class="section-title">Wallpaper</div>
                <div class="list-card">
                    <div class="list-row">
                        <div><div class="row-title">Chat wallpaper</div><div class="hint">Applies only to this chat</div></div>
                        <div style="display:flex;gap:8px">
                            <button class="btn small" data-action="chat-wall-upload">Change</button>
                            <button class="btn small" data-action="chat-wall-remove">Remove</button>
                        </div>
                    </div>
                </div>`;
        }

        function changePhone() {
            const phone = prompt('Phone number (leave empty to remove it)', S().phone || '');
            if (phone === null) return;
            state.socket.emit('change-phone', { phone: phone.trim() }, (res) => {
                if (!res || !res.success) return toast(res?.error || 'Could not save the number');
                if (state.settings) state.settings.phone = res.phone;
                toast('Phone number saved');
                if (state.pages.length) renderPage();
            });
        }

        function saveProfile() {
            const name = $('acc-name').value.trim().slice(0, 40);
            const about = $('acc-about').value.trim().slice(0, 140);
            saveSettings({ displayName: name || null, about }, 'Profile saved');
        }

        function openAvatarEditor() {
            pickFile().then(async (file) => {
                if (!file) return;
                const data = await openEditor(file, { square: true, outMax: 400, limit: 600 * 1024 });
                if (data) saveSettings({ customAvatar: data }, 'Profile photo updated');
            });
        }

        function openWallpaperEditor() {
            pickFile().then(async (file) => {
                if (!file) return;
                const data = await openEditor(file, { outMax: 1280 });
                if (data) saveSettings({ customBackground: data }, 'Wallpaper updated');
            });
        }

        function openChatWallpaperEditor() {
            const partner = state.chat.partner;
            if (!partner) return;
            pickFile().then(async (file) => {
                if (!file) return;
                const data = await openEditor(file, { outMax: 1280 });
                if (data) setPrefsFor(partner, { wallpaper: data }, 'Wallpaper updated');
            });
        }

        function runAction(name, el) {
            switch (name) {
                case 'back': return backPage();
                case 'main-menu': return $('main-sheet').hidden = false;
                case 'open-contacts': return showTab('contacts');
                case 'new-group': return openNewGroupPage();
                case 'create-group': return createGroup();
                case 'fwd-send': return sendForward();
                case 'add-status': return openStatusComposer();
                case 'my-status': {
                    const mine = groupStatuses().get(state.user);
                    return mine && mine.length ? openViewer(state.user) : openStatusComposer();
                }
                case 'attach-camera': return attachPhoto();
                case 'toggle-search': {
                    const wrap = document.getElementById('chat-search-wrap');
                    wrap.hidden = !wrap.hidden;
                    if (!wrap.hidden) $('chat-search').focus();
                    return;
                }
                case 'toggle-archived':
                    state.showArchived = !state.showArchived;
                    return renderChatsTab();
                case 'logout': return logout();
                case 'delete-account': return deleteAccount();
                case 'save-profile': return saveProfile();
                case 'change-photo': return openAvatarEditor();
                case 'remove-photo': return saveSettings({ customAvatar: null }, 'Profile photo removed');
                case 'wall-upload': return openWallpaperEditor();
                case 'wall-remove': return saveSettings({ customBackground: null }, 'Wallpaper removed');
                case 'chat-wall-upload': return openChatWallpaperEditor();
                case 'chat-wall-remove': return setPrefsFor(state.chat.partner, { wallpaper: null }, 'Wallpaper removed');
                case 'unblock': return unblockUser(el.dataset.user, () => renderPage());
                case 'profile-message': {
                    const username = state.pageData.profile?.username;
                    closeAllPages();
                    if (username) openChat(username);
                    return;
                }
                case 'profile-report': return openReport('profile', state.pageData.profile?.username);
                case 'profile-starred': return openPage('starred');
                case 'profile-audio':
                case 'profile-video': {
                    const u = state.pageData.profile?.username;
                    closeAllPages();
                    if (u) { openChat(u); openCall(name === 'profile-video' ? 'video' : 'voice'); }
                    return;
                }
                case 'profile-search': {
                    const u = state.pageData.profile?.username;
                    closeAllPages();
                    if (u) { openChat(u); openFind(); }
                    return;
                }
                case 'profile-block': {
                    const username = state.pageData.profile?.username;
                    if (!username) return;
                    if (S().blockedUsers.includes(username)) unblockUser(username, () => loadUserProfile(username));
                    else if (confirm(`Block ${username}?`)) blockUser(username, () => loadUserProfile(username));
                    return;
                }
                case 'g-photo': return changeGroupPhoto();
                case 'g-rename': return renameGroup();
                case 'g-desc': return editGroupDescription();
                case 'g-add': return openPage('addmembers');
                case 'g-audio': return toast('Group calls are coming soon');
                case 'g-video': return toast('Group calls are coming soon');
                case 'g-search': closeAllPages(); return openFind();
                case 'change-phone': return changePhone();
                case 'g-member': return openMemberSheet(el.dataset.user);
                case 'g-exit': return exitGroup();
                case 'g-delete': return deleteGroup();
                case 'am-save': return saveAddMembers();
                case 'explore-channels': return openExploreChannels();
                case 'new-channel': return openPage('newchannel');
                case 'nc-photo': return pickChannelPhoto();
                case 'nc-create': return createChannel();
                case 'ch-photo': return changeChannelPhoto();
                case 'ch-rename': return renameChannel();
                case 'ch-desc': return editChannelDescription();
                case 'ch-subscribe': return toggleChannelSubscription();
                case 'ch-add-admin': return addChannelAdmin();
                case 'ch-remove-admin': return removeChannelAdmin(el.dataset.user);
                case 'ch-delete': return deleteChannel();
            }
        }

        // Event bindings

        function bindEvents() {
            $('get-started').onclick = () => showScreen('auth');
            $('reg-photo-btn').onclick = pickRegPhoto;
            $('login-btn').onclick = login;
            $('register-btn').onclick = register;
            $('go-register').onclick = (e) => { e.preventDefault(); showAuthForm('register'); };
            $('go-login').onclick = (e) => { e.preventDefault(); showAuthForm('login'); };
            $('go-forgot').onclick = (e) => { e.preventDefault(); showAuthForm('forgot'); };
            $('go-login-2').onclick = (e) => { e.preventDefault(); showAuthForm('login'); };
            $('forgot-btn').onclick = sendForgotRequest;
            $('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
            $('reg-password').addEventListener('keydown', e => { if (e.key === 'Enter') register(); });
            document.querySelectorAll('[data-eye]').forEach(btn => {
                btn.onclick = () => { const input = $(btn.dataset.eye); input.type = input.type === 'password' ? 'text' : 'password'; };
            });

            document.querySelectorAll('.nav-btn').forEach(btn => { btn.onclick = () => showTab(btn.dataset.tab); });

            $('app').addEventListener('click', (e) => {
                const open = e.target.closest('[data-open]');
                if (open) {
                    if (state.suppressOpen) { state.suppressOpen = false; return; }
                    return openChat(open.dataset.open);
                }
                const jump = e.target.closest('[data-jump-chat]');
                if (jump) {
                    const key = jump.dataset.jumpChat;
                    const id = key.slice(2);
                    return key.startsWith('g:') ? openGroupChat(id) : openChat(id);
                }
                const channelRow = e.target.closest('[data-channel]');
                if (channelRow) return openChannel(channelRow.dataset.channel);
                const group = e.target.closest('[data-group]');
                if (group) return openGroupChat(group.dataset.group);
                const filter = e.target.closest('[data-filter]');
                if (filter) {
                    state.filter = filter.dataset.filter;
                    document.querySelectorAll('[data-filter]').forEach(c => c.classList.toggle('active', c === filter));
                    return renderChatsTab();
                }
                const view = e.target.closest('[data-view]');
                if (view) return openViewer(view.dataset.view);
                const page = e.target.closest('[data-page]');
                if (page) return openPage(page.dataset.page, page.dataset.mediaGroup ? { groupId: page.dataset.mediaGroup } : undefined);
                const action = e.target.closest('[data-action]');
                if (action) return runAction(action.dataset.action, action);
            });

            $('chat-search').addEventListener('input', () => { renderChatsTab(); runGlobalSearch(); });
            $('contact-search').addEventListener('input', onContactSearch);
            $('online-toggle').onclick = () => {
                $('online-toggle').classList.toggle('on');
                $('online-toggle').classList.toggle('active');
                renderContacts();
            };

            const list = $('conversation-list');
            list.addEventListener('pointerdown', (e) => { const row = e.target.closest('[data-open]'); if (row) startRowPress(row.dataset.open); });
            ['pointerup', 'pointerleave', 'pointercancel'].forEach(evt => list.addEventListener(evt, cancelRowPress));
            list.addEventListener('contextmenu', (e) => e.preventDefault());

            $('row-sheet').addEventListener('click', (e) => {
                if (e.target === $('row-sheet')) { $('row-sheet').hidden = true; return; }
                const btn = e.target.closest('[data-row]');
                if (btn) runRowAction(btn.dataset.row);
            });

            $('main-sheet').addEventListener('click', (e) => {
                if (e.target === $('main-sheet')) { $('main-sheet').hidden = true; return; }
                const btn = e.target.closest('[data-main]');
                if (btn) runMainAction(btn.dataset.main);
            });

            $('page').addEventListener('click', (e) => {
                if (e.target.closest('[data-soon]')) return toast('Coming soon');
                const sub = e.target.closest('[data-subscribe]');
                if (sub) return toggleExploreSub(sub.dataset.subscribe, sub.dataset.on === '1');
                const chRow = e.target.closest('[data-channel]');
                if (chRow) { closeAllPages(); return openChannel(chRow.dataset.channel); }
                const swatch = e.target.closest('[data-chat-color]');
                if (swatch) return setPrefsFor(state.chat.partner, { color: swatch.dataset.chatColor || null }, 'Colour updated');

                const unstar = e.target.closest('[data-unstar]');
                if (unstar) {
                    const id = unstar.dataset.unstar;
                    state.socket.emit('star-message', { messageId: id, on: false }, () => loadStarred());
                    return;
                }

                const lightboxImg = e.target.closest('[data-lightbox]');
                if (lightboxImg && lightboxImg.tagName === 'IMG') return openLightbox(lightboxImg.src);

                const action = e.target.closest('[data-action]');
                if (action) return runAction(action.dataset.action, action);

                const pageLink = e.target.closest('[data-page]');
                if (pageLink) return openPage(pageLink.dataset.page, pageLink.dataset.mediaUser ? { target: pageLink.dataset.mediaUser } : (pageLink.dataset.mediaGroup ? { groupId: pageLink.dataset.mediaGroup } : undefined));

                const chatOpen = e.target.closest('[data-open]');
                if (chatOpen) { closeAllPages(); openChat(chatOpen.dataset.open); }
            });
            $('page').addEventListener('change', (e) => {
                if (e.target.dataset.local) { localStorage.setItem(e.target.dataset.local, e.target.checked ? '1' : '0'); return; }
                const groupKey = e.target.dataset.groupSetting;
                if (groupKey) return setGroupSetting(groupKey, e.target.checked);
                const key = e.target.dataset.setting;
                if (!key) return;
                const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
                saveSettingPath(key, value);
            });
            $('page').addEventListener('input', (e) => {
                if (e.target.id === 'ex-search') loadExplore(e.target.value.trim());
                if (e.target.id === 'am-search') {
                    const g = state.pageData.group;
                    const candidates = state.contacts.filter(p => !g.members.includes(p.username));
                    $('am-list').innerHTML = checkListHTML(candidates, [], e.target.value);
                }
            });
            document.addEventListener('input', (e) => {
                if (e.target.id === 'ng-search') {
                    const selected = [...document.querySelectorAll('[data-member]:checked')].map(i => i.dataset.member);
                    $('ng-list').innerHTML = checkListHTML(state.contacts, selected, e.target.value);
                }
            });

            document.addEventListener('change', (e) => {
                if (e.target.closest('#page')) return;
                const groupKey = e.target.dataset.groupSetting;
                if (groupKey) return setGroupSetting(groupKey, e.target.checked);
                const key = e.target.dataset.setting;
                if (!key) return;
                const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
                saveSettingPath(key, value);
            });

            $('chat-sheet').addEventListener('click', (e) => {
                if (e.target === $('chat-sheet')) { $('chat-sheet').hidden = true; return; }
                const btn = e.target.closest('[data-sheet]');
                if (btn) runSheetAction(btn.dataset.sheet);
            });
            $('member-sheet').addEventListener('click', (e) => {
                if (e.target === $('member-sheet')) { $('member-sheet').hidden = true; return; }
                const btn = e.target.closest('[data-member-action]');
                if (btn) runMemberAction(btn.dataset.memberAction);
            });
            $('msg-sheet').addEventListener('click', (e) => {
                if (e.target === $('msg-sheet')) { $('msg-sheet').hidden = true; return; }
                const react = e.target.closest('[data-react]');
                if (react) return runMsgAction('react', react.dataset.react);
                const btn = e.target.closest('[data-msg]');
                if (btn) runMsgAction(btn.dataset.msg);
            });

            bindViewerHold();
            $('viewer-close').onclick = closeViewer;
            $('viewer-prev').onclick = () => { if (!state.viewer.held) prevStatus(); };
            $('viewer-next').onclick = () => { if (!state.viewer.held) nextStatus(); };
            $('viewer-delete').onclick = deleteCurrentStatus;
            $('viewer-foot').addEventListener('keydown', (e) => { if (e.target.id === 'status-reply' && e.key === 'Enter') sendStatusReply(); });
            $('viewer-report').onclick = () => { const item = state.viewer.items[state.viewer.index]; if (item) openReport('status', item._id); };
            $('report-sheet').addEventListener('click', (e) => {
                if (e.target === $('report-sheet')) { $('report-sheet').hidden = true; return; }
                const btn = e.target.closest('[data-reason]');
                if (btn) submitReport(btn.dataset.reason);
            });
            $('viewer-foot').addEventListener('click', (e) => {
                const item = state.viewer.items[state.viewer.index];
                if (!item) return;
                if (e.target.closest('[data-viewers]')) return openStatusPeople('views');
                if (e.target.closest('[data-likers]')) return openStatusPeople('likes');
                if (e.target.closest('[data-like]')) return toggleLike(item);
            });
            $('people-tabs').addEventListener('click', (e) => {
                const tab = e.target.closest('[data-kind]');
                if (!tab) return;
                state.viewer.sheet = tab.dataset.kind;
                renderStatusPeople();
            });
            $('people-sheet').addEventListener('click', (e) => {
                if (e.target === $('people-sheet') || e.target.closest('[data-people-close]')) closeStatusPeople();
            });

            $('sc-close').onclick = () => { $('composer-status').hidden = true; };
            $('sc-post').onclick = postStatus;
            $('sc-photo').onclick = addStatusPhoto;
            $('sc-remove-photo').onclick = () => { state.composer.image = null; renderStatusComposer(); };
            $('sc-swatches').onclick = (e) => {
                const btn = e.target.closest('[data-bg]');
                if (!btn) return;
                state.composer.bg = btn.dataset.bg;
                state.composer.image = null;
                renderStatusComposer();
            };

            $('chat-back').onclick = () => closeChat();
            $('chat-id').onclick = () => {
                if (state.chat.kind === 'group') openGroupInfo();
                else if (state.chat.partner) openUserProfile(state.chat.partner);
            };
            $('chat-call').onclick = () => openCall('voice');
            $('emoji-btn').onclick = openEmojiSheet;
            $('emoji-sheet').addEventListener('click', (e) => {
                if (e.target === $('emoji-sheet')) { $('emoji-sheet').hidden = true; return; }
                const b = e.target.closest('[data-emoji-pick]');
                if (b) pickEmoji(b.dataset.emojiPick);
            });
            $('chat-video-call').onclick = () => openCall('video');
            document.addEventListener('click', (e) => { if (e.target.closest('[data-close-call]')) closeCalls(); });
            $('install-yes').onclick = () => {
                localStorage.setItem('bm_install_done', '1');
                $('install-prompt').hidden = true;
                if (window.deferredInstall) window.deferredInstall.prompt();
                else toast('Use your browser menu to add B-Messenger to your home screen');
            };
            $('install-no').onclick = () => {
                localStorage.setItem('bm_install_done', '1');
                $('install-prompt').hidden = true;
            };
            window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); window.deferredInstall = e; });
            $('chat-more').onclick = openChatSheet;
            $('attach-btn').onclick = attachPhoto;
            $('oneview-btn').onclick = toggleOneView;
            $('context-close').onclick = () => { state.replyTo = null; state.editing = null; $('message-input').value = ''; renderContext(); updateActionButton(); };
            $('message-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendText(); } });
            $('message-input').addEventListener('input', () => {
                updateActionButton();
                const chat = state.chat;
                if (!state.socket) return;
                const hasText = $('message-input').value.trim().length > 0;
                if (!hasText) { clearTimeout(chat.stopTimer); emitActivity('typing', false); return; }
                const now = Date.now();
                if (now - chat.lastSent > 2000) { emitActivity('typing', true); chat.lastSent = now; }
                clearTimeout(chat.stopTimer);
                chat.stopTimer = setTimeout(() => emitActivity('typing', false), 1500);
            });
            $('action-btn').onclick = () => {
                if ($('action-btn').dataset.mode === 'send') sendText();
                else startVoice();
            };
            $('rec-cancel').onclick = () => stopVoice(true);
            $('rec-send').onclick = () => stopVoice(false);

            // Long press a message to open its actions; a short tap still works as before
            const messages = $('chat-messages');
            let msgTimer = null;
            let msgStart = null;
            messages.addEventListener('pointerdown', (e) => {
                if (e.target.closest('button, audio, a')) return;
                const bubble = e.target.closest('.bubble[data-id]');
                if (!bubble) return;
                state.suppressTap = false;
                clearTimeout(msgTimer);
                msgStart = { x: e.clientX, y: e.clientY };
                msgTimer = setTimeout(() => {
                    state.suppressTap = true;
                    if (navigator.vibrate) navigator.vibrate(12);
                    openMsgSheet(bubble.dataset.id);
                }, MSG_HOLD_MS);
            });
            ['pointerup', 'pointerleave', 'pointercancel', 'pointermove'].forEach(evt => {
                messages.addEventListener(evt, (e) => {
                    if (evt === 'pointermove' && msgStart && Math.hypot(e.clientX - msgStart.x, e.clientY - msgStart.y) < 12) return;
                    clearTimeout(msgTimer);
                });
            });
            messages.addEventListener('contextmenu', (e) => e.preventDefault());

            // Swipe a message sideways to reply to it
            let swipe = null;
            messages.addEventListener('pointerdown', (e) => {
                if (e.target.closest('button, audio, a')) return;
                const bubble = e.target.closest('.bubble[data-id]');
                if (!bubble || bubble.classList.contains('deleted')) return;
                swipe = { el: bubble, id: bubble.dataset.id, x: e.clientX, y: e.clientY, active: false, lastDx: 0 };
            });
            messages.addEventListener('pointermove', (e) => {
                if (!swipe) return;
                const dx = e.clientX - swipe.x;
                const dy = e.clientY - swipe.y;
                if (!swipe.active) {
                    // Only a mostly sideways drag counts as a swipe; up and down still scrolls the chat
                    if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
                    swipe.active = true;
                    swipe.el.style.transition = 'none';
                    clearTimeout(msgTimer);
                    state.suppressTap = true;
                }
                swipe.lastDx = dx;
                swipe.el.style.transform = `translateX(${Math.max(-90, Math.min(90, dx))}px)`;
            });
            const endSwipe = () => {
                if (!swipe) return;
                const s = swipe;
                swipe = null;
                if (!s.active) return;
                s.el.style.transition = '';
                s.el.style.transform = '';
                if (Math.abs(s.lastDx) >= 55) {
                    const m = state.messageIndex.get(String(s.id));
                    if (m && !m.system) {
                        state.replyTo = m;
                        state.editing = null;
                        renderContext();
                        $('message-input').focus();
                    }
                }
            };
            ['pointerup', 'pointercancel'].forEach(evt => messages.addEventListener(evt, endSwipe));

            messages.addEventListener('click', (e) => {
                if (state.suppressTap) { state.suppressTap = false; return; }
                const del = e.target.closest('[data-del]');
                if (del) return deleteMessage(del.dataset.del);
                const one = e.target.closest('[data-open-one]');
                if (one) return openOneView(one.dataset.openOne);
                const quote = e.target.closest('[data-jump]');
                if (quote) return scrollToMessage(quote.dataset.jump);
                const img = e.target.closest('img.bubble-img');
                if (img) openLightbox(img.src);
            });

            $('find-input').addEventListener('input', runFind);
            $('find-next').onclick = () => jumpHit(1);
            $('find-prev').onclick = () => jumpHit(-1);
            $('find-close').onclick = closeFind;

            $('chat-messages').addEventListener('scroll', () => {
                if ($('chat-messages').scrollTop < 60) loadOlderMessages();
            });

            $('blocked-bar').addEventListener('click', (e) => { if (e.target.closest('#unblock-chat')) unblockFromChat(); });

            $('channel-back').onclick = closeChannel;
            $('channel-id').onclick = () => { if (state.channelView) openChannelInfo(state.channelView.id); };
            $('channel-more').onclick = openChannelMenu;
            $('channel-send').onclick = postToChannel;
            $('channel-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); postToChannel(); } });
            $('channel-photo').onclick = postChannelPhoto;
            $('channel-voice').onclick = toggleChannelVoice;
            $('channel-notice').addEventListener('click', (e) => { if (e.target.closest('[data-channel-sub]')) toggleChannelSubscription(); });

            const channelPostsEl = $('channel-posts');
            channelPostsEl.addEventListener('click', (e) => {
                if (state.suppressTap) { state.suppressTap = false; return; }
                const cdel = e.target.closest('[data-cdel]');
                if (cdel) return deleteChannelPost(cdel.dataset.cdel);
                const react = e.target.closest('[data-post-react]');
                if (react) return reactToPost(react.dataset.postReact, react.dataset.emoji);
                const img = e.target.closest('img.post-img');
                if (img) openLightbox(img.src);
            });
            let postTimer = null;
            channelPostsEl.addEventListener('pointerdown', (e) => {
                if (e.target.closest('button, audio, [data-post-react]')) return;
                const post = e.target.closest('.post[data-post]');
                if (!post) return;
                state.suppressTap = false;
                clearTimeout(postTimer);
                postTimer = setTimeout(() => { state.suppressTap = true; openPostSheet(post.dataset.post); }, MSG_HOLD_MS);
            });
            ['pointerup', 'pointerleave', 'pointercancel', 'pointermove'].forEach(evt => {
                channelPostsEl.addEventListener(evt, () => clearTimeout(postTimer));
            });
            channelPostsEl.addEventListener('contextmenu', (e) => e.preventDefault());

            $('post-sheet').addEventListener('click', (e) => {
                if (e.target === $('post-sheet')) { $('post-sheet').hidden = true; return; }
                const react = e.target.closest('[data-ch-react]');
                if (react) {
                    $('post-sheet').hidden = true;
                    return reactToPost(state.postTarget, react.dataset.chReact);
                }
                const act = e.target.closest('[data-ch-act]');
                if (act) runPostSheetAction(act.dataset.chAct);
            });

            document.addEventListener('click', (e) => {
                const z = e.target.closest('[data-zoom]');
                if (!z) return;
                e.preventDefault();
                e.stopPropagation();
                openLightbox(z.dataset.zoom);
            }, true);

            $('lightbox').onclick = closeLightbox;
            $('lightbox-img').addEventListener('contextmenu', (e) => e.preventDefault());

            document.addEventListener('keydown', (e) => {
                if (e.key !== 'Escape') return;
                if (!$('lightbox').hidden) closeLightbox();
                else if (!$('editor').hidden) $('editor').querySelector('[data-ed="cancel"]')?.click();
                else if (!$('msg-sheet').hidden) $('msg-sheet').hidden = true;
                else if (!$('member-sheet').hidden) $('member-sheet').hidden = true;
                else if (!$('people-sheet').hidden) closeStatusPeople();
                else if (!$('main-sheet').hidden) $('main-sheet').hidden = true;
                else if (!$('chat-sheet').hidden) $('chat-sheet').hidden = true;
                else if (!$('row-sheet').hidden) $('row-sheet').hidden = true;
                else if (!$('viewer').hidden) closeViewer();
                else if (!$('composer-status').hidden) $('composer-status').hidden = true;
                else if (!$('chat').hidden) closeChat();
                else if (!$('page').hidden) backPage();
            });

            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
                if (S().theme === 'auto') applyTheme('auto');
            });
        }

        bindEvents();
        restoreSession();
    