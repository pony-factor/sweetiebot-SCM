// Decode dropped videos within the Codex webview and attach a bounded set of JPEGs.
// Changes are detected on tiny in-memory frames; only selected frames are encoded.
// Score small, uncompressed frames to identify UI state transitions.
function scmToolkitVideoDifference(previous, current) {
    if (!previous || !current || previous.length !== current.length || previous.length < 4) return 0;
    let change = 0;
    let changedPixels = 0;
    const pixels = previous.length / 4;
    for (let index = 0; index < previous.length; index += 4) {
        const delta = (Math.abs(previous[index] - current[index])
            + Math.abs(previous[index + 1] - current[index + 1])
            + Math.abs(previous[index + 2] - current[index + 2])) / 3;
        change += delta;
        if (delta >= 20) changedPixels++;
    }
    // Count the affected area as well as its contrast: a new dialog beats a tiny cursor move.
    return change / (pixels * 255) + 0.3 * changedPixels / pixels;
}

function scmToolkitSelectVideoTimes(samples, count, duration) {
    const uniform = Array.from({ length: count }, (_, index) =>
        duration * (index + 0.5) / count);
    if (count < 3 || !samples.length) return uniform;
    const selected = new Set();
    const nearest = target => samples.reduce((best, sample, index) =>
        Math.abs(sample.time - target) < Math.abs(samples[best].time - target) ? index : best, 0);
    // Always keep a beginning/end frame, even for videos with very busy motion.
    selected.add(nearest(uniform[0]));
    selected.add(nearest(uniform[count - 1]));
    const separation = Math.max(1, Math.floor(samples.length / (count * 2)));
    const spaced = index => [...selected].every(existing =>
        Math.abs(existing - index) >= separation);
    const changes = samples.map((sample, index) => ({
        index, score: sample.change,
    })).filter(sample => sample.score >= 0.012).sort((a, b) =>
        b.score - a.score || a.index - b.index);
    if (!changes.length) return uniform;
    for (const candidate of changes) {
        if (selected.size >= count) break;
        if (spaced(candidate.index)) selected.add(candidate.index);
    }
    // For static or mostly static clips, fill remaining slots with broad timeline coverage.
    for (const time of uniform) {
        if (selected.size >= count) break;
        const choices = samples.map((sample, index) => ({ index,
            distance: Math.abs(sample.time - time) }))
            .filter(candidate => !selected.has(candidate.index))
            .sort((a, b) => a.distance - b.distance);
        selected.add((choices.find(choice => spaced(choice.index)) || choices[0]).index);
    }
    return [...selected].map(index => samples[index].time).sort((a, b) => a - b);
}

async function scmToolkitScanVideo(video, count, duration, seekTo) {
    const sampleCount = Math.min(64, Math.max(count * 3, Math.ceil(duration * 2)));
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context || typeof context.getImageData !== 'function') return [];
    const samples = [];
    const start = Date.now();
    let previous;
    for (let index = 0; index < sampleCount; index++) {
        // Stop expensive probing and use ordinary timeline sampling if the decoder is slow.
        if (Date.now() - start > 12000) return [];
        const time = duration * (index + 0.5) / sampleCount;
        await seekTo(time, 1500);
        context.drawImage(video, 0, 0, 160, 90);
        const pixels = context.getImageData(0, 0, 160, 90).data;
        samples.push({ time, change: previous ? scmToolkitVideoDifference(previous, pixels) : 0 });
        previous = new Uint8ClampedArray(pixels);
    }
    return samples;
}

async function scmToolkitVideoScreenshots(file, maxFrames = 8) {
    if (!file?.size) throw new Error('The video file is empty.');
    const waitFor = (element, type, timeoutMs) => new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timeout);
            element.removeEventListener(type, success);
            element.removeEventListener('error', failure);
        };
        const success = () => { cleanup(); resolve(); };
        const failure = () => { cleanup(); reject(new Error('The video could not be decoded.')); };
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Video decoding took too long.'));
        }, timeoutMs);
        element.addEventListener(type, success);
        element.addEventListener('error', failure);
    });
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    try {
        video.preload = 'auto';
        video.muted = true;
        video.playsInline = true;
        const loaded = waitFor(video, 'loadeddata', 15000);
        video.src = url;
        video.load();
        await loaded;
        const duration = video.duration;
        if (!Number.isFinite(duration) || duration <= 0 || !video.videoWidth || !video.videoHeight) {
            throw new Error('The video has no readable duration or frames.');
        }
        const frameCount = Math.min(Math.max(1, Math.floor(maxFrames)),
            duration < 0.3 ? 1 : duration < 2 ? 3 : duration < 8 ? 5 : 8);
        const seekTo = async (timestamp, timeout = 10000) => {
            if (video.readyState >= 2 && Math.abs(video.currentTime - timestamp) < 0.001) return;
            const seeked = waitFor(video, 'seeked', timeout);
            video.currentTime = timestamp;
            await seeked;
        };
        let samples = [];
        if (frameCount >= 3) {
            try {
                samples = await scmToolkitScanVideo(video, frameCount, duration, seekTo);
            } catch {
                // An unavailable readback, seek, or slow decoder should not prevent
                // normal screenshot attachments if the video itself can be read.
                samples = [];
            }
        }
        const times = scmToolkitSelectVideoTimes(samples, frameCount, duration);
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Screenshot capture is unavailable.');
        const baseName = String(file.name || 'video').replace(/\.[^.]+$/, '').slice(0, 100) || 'video';
        const frames = [];
        for (const timestamp of times) {
            await seekTo(timestamp);
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise((resolve, reject) => canvas.toBlob(
                output => output ? resolve(output) : reject(new Error('Could not encode screenshot.')),
                'image/jpeg', 0.82
            ));
            const seconds = Math.round(timestamp * 100) / 100;
            frames.push(new File([blob], baseName + '-at-' + seconds + 's.jpg', { type: 'image/jpeg' }));
        }
        return frames;
    } finally {
        video.pause();
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
    }
}
