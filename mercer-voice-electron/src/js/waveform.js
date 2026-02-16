window.waveform = {
    canvas: null,
    ctx: null,
    levels: [],
    displayLevels: [],
    maxLevels: 28,
    animFrameId: null,
    dpr: 1,
    smoothing: 0.22,

    init() {
        this.canvas = document.getElementById('waveformCanvas');
        if (!this.canvas) return;
        this.dpr = window.devicePixelRatio || 1;
        const w = 70, h = 18;
        this.canvas.width = Math.round(w * this.dpr);
        this.canvas.height = Math.round(h * this.dpr);
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = h + 'px';
        this.ctx = this.canvas.getContext('2d');
        this.levels = new Array(this.maxLevels).fill(0.08);
        this.displayLevels = new Array(this.maxLevels).fill(0.08);
        this.startRendering();
    },

    pushLevel(level) {
        if (!this.canvas) this.init();
        if (!this.canvas) return;
        this.levels.push(level);
        if (this.levels.length > this.maxLevels) this.levels.shift();
    },

    startRendering() {
        const render = () => {
            this.draw();
            this.animFrameId = requestAnimationFrame(render);
        };
        this.animFrameId = requestAnimationFrame(render);
    },

    stopRendering() {
        if (this.animFrameId) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = null;
        }
    },

    draw() {
        const { canvas, ctx, levels, dpr, smoothing } = this;
        if (!canvas || !ctx) return;

        while (this.displayLevels.length < levels.length) this.displayLevels.push(0.08);
        while (this.displayLevels.length > levels.length) this.displayLevels.pop();
        for (let i = 0; i < levels.length; i++) {
            this.displayLevels[i] += (levels[i] - this.displayLevels[i]) * smoothing;
        }

        const w = canvas.width;
        const h = canvas.height;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const barCount = this.displayLevels.length;
        const barWidth = Math.max(1, Math.round(1.5 * dpr));
        const gap = Math.max(1, Math.round(1 * dpr));
        const totalBarWidth = barWidth + gap;
        const startX = Math.round((w - barCount * totalBarWidth + gap) / 2);
        const centerY = Math.round(h / 2);
        const maxBarHeight = h * 0.85;
        const minBarHeight = Math.max(2, Math.round(2 * dpr));
        const radius = Math.round(barWidth / 2);

        ctx.fillStyle = '#ffffff';
        for (let i = 0; i < barCount; i++) {
            const level = this.displayLevels[barCount - 1 - i];
            const barHeight = Math.max(minBarHeight, Math.round(level * maxBarHeight));
            const x = Math.round(startX + i * totalBarWidth);
            const y = Math.round(centerY - barHeight / 2);

            ctx.globalAlpha = 0.4 + Math.min(level, 1) * 0.6;
            ctx.beginPath();
            ctx.roundRect(x, y, barWidth, barHeight, radius);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    },

    reset() {
        this.stopRendering();
        this.levels = [];
        this.displayLevels = [];
        this.canvas = null;
        this.ctx = null;
    }
};
