window.waveform = {
    canvas: null,
    ctx: null,
    levels: [],
    maxLevels: 60,
    animFrameId: null,

    init() {
        this.canvas = document.getElementById('waveformCanvas');
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        this.levels = new Array(this.maxLevels).fill(0.05);
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
        const { canvas, ctx, levels } = this;
        if (!canvas || !ctx) return;

        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        const barCount = levels.length;
        const barWidth = 3;
        const gap = 2;
        const totalBarWidth = barWidth + gap;
        const startX = (w - barCount * totalBarWidth) / 2;

        const centerY = h / 2;
        const maxBarHeight = h * 0.8;
        const minBarHeight = 3;

        for (let i = 0; i < barCount; i++) {
            const level = levels[i];
            const barHeight = Math.max(minBarHeight, level * maxBarHeight);
            const x = startX + i * totalBarWidth;
            const y = centerY - barHeight / 2;

            ctx.fillStyle = `rgba(217, 119, 6, ${0.6 + level * 0.4})`;
            ctx.beginPath();
            ctx.roundRect(x, y, barWidth, barHeight, 1.5);
            ctx.fill();
        }
    },

    reset() {
        this.stopRendering();
        this.levels = [];
        this.canvas = null;
        this.ctx = null;
    }
};
