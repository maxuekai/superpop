import { COLORS, FOOD, PLAYER, VIEW, WORLD } from '../config.js';
import { Camera } from './camera.js';
import { Map } from './map.js';
import { Player } from './player.js';
import { distance, randomInt, randomItem } from './utils.js';

// 游戏主循环：update 推进状态，draw 渲染
export class Game {
    constructor(canvas) {
        this.canvas = canvas;
        this.context = canvas.getContext('2d');

        this.world = { width: WORLD.width, height: WORLD.height };

        // 玩家随机出生在地图内（带边距），食物生成时避开玩家
        const spawn = this.randomPosition(PLAYER.radius + 20);
        this.player = new Player(spawn.x, spawn.y, PLAYER.radius, randomItem(COLORS));

        this.foodList = [];
        for (let i = 0; i < FOOD.count; i += 1) {
            this.foodList.push(this.spawnFood());
        }

        this.map = new Map(this.world.width, this.world.height);

        this.camera = new Camera(0, 0, 0, 0, this.world.width, this.world.height);
        this.camera.follow(this.player);

        this.weightEl = document.querySelector('.weight');

        // 世界单位 → CSS 像素的缩放；resize()/updateViewScale() 里计算
        this.scale = 1;
        this.cssWidth = 0;
        this.cssHeight = 0;
        this.fitScale = 1;
        this.resize = this.resize.bind(this);
        this.resize();

        this.loop = this.loop.bind(this);
    }

    // 地图内随机一点（带边距），供出生点等使用
    randomPosition(margin) {
        return {
            x: margin + randomInt(this.world.width - margin * 2),
            y: margin + randomInt(this.world.height - margin * 2),
        };
    }

    // 生成一颗食物，位置尽量避开玩家（避免刷在脸上白送）
    spawnFood() {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const pos = this.randomPosition(FOOD.radius + 4);
            if (distance(pos.x, pos.y, this.player.x, this.player.y) >= this.player.r + 40) {
                return { x: pos.x, y: pos.y, color: randomItem(COLORS) };
            }
        }
        const pos = this.randomPosition(FOOD.radius + 4);
        return { x: pos.x, y: pos.y, color: randomItem(COLORS) };
    }

    // 画布铺满窗口，并按 devicePixelRatio 渲染保证手机清晰度
    resize() {
        const dpr = window.devicePixelRatio || 1;
        this.cssWidth = window.innerWidth;
        this.cssHeight = window.innerHeight;
        this.canvas.width = Math.round(this.cssWidth * dpr);
        this.canvas.height = Math.round(this.cssHeight * dpr);

        // 保证视口不大于整个世界（否则相机会被钳制出负坐标）
        this.fitScale = Math.max(this.cssWidth / this.world.width, this.cssHeight / this.world.height);
        this.updateViewScale();
    }

    // 视野缩放：屏幕长边锚定 VIEW.longEdgeWorld 个世界单位，并随体型放大视距
    updateViewScale() {
        const sizeZoom = Math.pow(this.player.r / PLAYER.radius, VIEW.zoomExponent);
        this.scale = Math.max(
            this.fitScale,
            Math.max(this.cssWidth, this.cssHeight) / (VIEW.longEdgeWorld * sizeZoom),
        );
        this.camera.setViewSize(this.cssWidth / this.scale, this.cssHeight / this.scale);
    }

    update() {
        // 限制球球不超出地图，并推进位置
        this.player.update(this.world.width, this.world.height);
        // 体型变化 → 视距跟着变
        this.updateViewScale();
        // 相机跟随
        this.camera.update();
    }

    draw() {
        const { context, camera, map, player } = this;
        const dpr = window.devicePixelRatio || 1;

        // 每帧重置变换：按 DPR × 世界缩放 渲染，再平移到相机视口
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, this.canvas.width, this.canvas.height);
        context.save();
        context.scale(dpr * this.scale, dpr * this.scale);
        context.translate(-camera.xView, -camera.yView);

        map.draw(context, camera);

        // 只画视口内的食物（食物动态绘制，吃掉/重生都不需要重烤地图）
        const viewLeft = camera.xView;
        const viewRight = camera.xView + camera.wView;
        const viewTop = camera.yView;
        const viewBottom = camera.yView + camera.hView;
        for (const food of this.foodList) {
            if (
                food.x < viewLeft - FOOD.radius || food.x > viewRight + FOOD.radius ||
                food.y < viewTop - FOOD.radius || food.y > viewBottom + FOOD.radius
            ) {
                continue;
            }
            context.save();
            context.fillStyle = food.color;
            context.beginPath();
            context.arc(food.x, food.y, FOOD.radius, 0, Math.PI * 2);
            context.closePath();
            context.stroke();
            context.fill();
            context.restore();
        }

        player.draw(context);

        // 吃到食物：移除并立即重生一颗，保持场上总量、体重面板同步
        for (let i = this.foodList.length - 1; i >= 0; i -= 1) {
            if (player.canEat(this.foodList[i].x, this.foodList[i].y)) {
                this.foodList.splice(i, 1);
                this.foodList.push(this.spawnFood());
                player.r += PLAYER.growthPerFood;
                player.onEat();
                this.updateWeight();
            }
        }

        context.restore();
    }

    updateWeight() {
        if (this.weightEl !== null) {
            this.weightEl.textContent = Math.round(this.player.r * this.player.r);
        }
    }

    loop() {
        this.update();
        this.draw();
        window.requestAnimationFrame(this.loop);
    }

    start() {
        this.updateWeight();
        window.requestAnimationFrame(this.loop);
    }
}
