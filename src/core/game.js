import { CANVAS, COLORS, FOOD, PLAYER, WORLD } from '../config.js';
import { Camera } from './camera.js';
import { Map } from './map.js';
import { Player } from './player.js';
import { randomInt, randomItem } from './utils.js';

function createFoodList() {
    const list = [];
    for (let i = 0; i < FOOD.count; i += 1) {
        list.push({
            x: randomInt(WORLD.width),
            y: randomInt(WORLD.height),
            color: randomItem(COLORS),
        });
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
        this.map.generate(this.foodList);

        this.player = new Player(50, 50, PLAYER.radius, randomItem(COLORS));

        this.camera = new Camera(0, 0, canvas.width, canvas.height, this.world.width, this.world.height);
        this.camera.follow(this.player, canvas.width / 2, canvas.height / 2);

        this.loop = this.loop.bind(this);
    }

    update() {
        // 限制球球不超出地图，并推进位置
        this.player.update(this.world.width, this.world.height);
        // 相机跟随
        this.camera.update();
    }

    draw() {
        const { context, camera, map, player } = this;
        context.clearRect(0, 0, this.canvas.width, this.canvas.height);

        map.draw(context, camera.xView, camera.yView);
        player.draw(context, camera.xView, camera.yView);

        // 吃到食物：移除、重绘地图、长大
        // TODO: 食物不会重生，吃完即止；且每次全图重绘开销大
        for (let i = 0; i < this.foodList.length; i += 1) {
            if (player.canEat(this.foodList[i].x, this.foodList[i].y)) {
                this.foodList.splice(i, 1);
                this.map.generate(this.foodList);
                player.r += PLAYER.growthPerFood;
            }
        }
    }

    loop() {
        this.update();
        this.draw();
        window.requestAnimationFrame(this.loop);
    }

    start() {
        window.requestAnimationFrame(this.loop);
    }
}
