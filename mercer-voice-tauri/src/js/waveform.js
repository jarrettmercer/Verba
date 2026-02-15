window.waveform = {
    canvas: null,
    ctx: null,
    levels: [],
    maxLevels: 14,
    animFrameId: null,
    dpr: 1,

    init() {
        this.canvas = document.getElementById('waveformCanvas');
        if (!this.canvas) return;
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = 70;
        const h = 18;
        this.canvas.width = w * this.dpr;
        this.canvas.height = h * this.dpr;
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = h + 'px';
        this.ctx = this.canvas.getContext('2d');
        this.levels = new Array(this.maxLevels).fill(0.12);
        this.startRendering();
    },

    pushLevel(level) {
        if (!this.canvas) this.init();
        if (!this.canvas) return;
        this.levels.push(level);
        if (this.levels.length > this.maxLevels) {
            this.levels.shift();
        }
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
        const { canvas, ctx, levels, dpr } = this;
        if (!canvas || !ctx) return;

        const w = 70;
        const h = 18;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, h);

        const barCount = levels.length;
        const barWidth = 3;
        const gap = 2;
        const totalBarWidth = barWidth + gap;
        const startX = Math.round((w - barCount * totalBarWidth) / 2);

        const centerY = h / 2;
        const maxBarHeight = h * 0.9;
        const minBarHeight = 3;

        ctx.fillStyle = '#ffffff';
        for (let i = 0; i < barCount; i++) {
            const level = levels[i];
            const barHeight = Math.max(minBarHeight, level * maxBarHeight);
            const x = Math.round(startX + i * totalBarWidth);
            const y = Math.round(centerY - barHeight / 2);
            const bh = Math.round(barHeight);

            ctx.fillRect(x, y, barWidth, bh);
        }
    },

    reset() {
        this.stopRendering();
        this.levels = [];
        this.canvas = null;
        this.ctx = null;
    }
};
