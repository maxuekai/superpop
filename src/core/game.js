import { COLORS, FOOD, PLAYER, VIEW, WORLD } from '../config.js';
import { Camera } from './camera.js';
import { Map } from './map.js';
import { Player } from './player.js';
import { randomInt, randomItem } from './utils.js';

function createFood() {
    return {
        x: randomInt(WORLD.width),
        y: randomInt(WORLD.height),
        color: randomItem(COLORS),
    };
}

function createFoodList() {
    const list = [];
    for (let i = 0; i < FOOD.count; i += 1) {
        list.push(createFood());
    }
    return list;
}

// 游戏主循环：update 推进状态，draw 渲染
export class Game {
    constructor(canvas) {
        this.canvas = canvas;
        this.context = canvas.getContext('2d');

        this.world = { width: WORLD.width, height: WORLD.height };
        this.foodList = createFoodList();
        this.map = new Map(this.world.width, this.world.height);

        this.player = new Player(50, 50, PLAYER.radius, randomItem(COLORS));

        this.camera = new Camera(0, 0, 0, 0, this.world.width, this.world.height);
        this.camera.follow(this.player);

        this.weightEl = document.querySelector('.weight');

        // 世界单位 → CSS 像素的缩放；resize() 里根据窗口计算
        this.scale = 1;
        this.resize = this.resize.bind(this);
        this.resize();

        this.loop = this.loop.bind(this);
    }

    // 画布铺满窗口，并按 devicePixelRatio 渲染保证手机清晰度
    resize() {
        const dpr = window.devicePixelRatio || 1;
        const cssWidth = window.innerWidth;
        const cssHeight = window.innerHeight;
        this.canvas.width = Math.round(cssWidth * dpr);
        this.canvas.height = Math.round(cssHeight * dpr);

        // 缩放锚定屏幕长边 = VIEW.longEdgeWorld 个世界单位；
        // 同时保证视口不大于整个世界（否则相机会被钳制出负坐标）
        const fitScale = Math.max(cssWidth / this.world.width, cssHeight / this.world.height);
        this.scale = Math.max(fitScale, Math.max(cssWidth, cssHeight) / VIEW.longEdgeWorld);

        this.camera.setViewSize(cssWidth / this.scale, cssHeight / this.scale);
    }

    update() {
        // 限制球球不超出地图，并推进位置
        this.player.update(this.world.width, this.world.height);
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
                this.foodList.push(createFood());
                player.r += PLAYER.growthPerFood;
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
