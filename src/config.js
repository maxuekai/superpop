// 全局游戏常量
export const WORLD = { width: 1024, height: 768 };
// 视野：屏幕上较长的一条边对应多少世界单位（类似缩放级别的锚点）。
// 实际渲染时会取「按此换算的缩放」和「窗口能装下整张地图的缩放」中较大的一个，
// 保证视口永远不超过世界大小（否则相机钳制会出问题）。
export const VIEW = { longEdgeWorld: 900 };
export const FOOD = { count: 100, radius: 2 };
export const PLAYER = {
    radius: 10,
    // speedX/speedY 每帧除以该值，相当于速度分母
    speedDivisor: 60,
    // 每吃一颗食物半径增长量
    growthPerFood: 0.5,
};
export const JOYSTICK = {
    // 摇杆面板半径（超出该距离摇杆头停在边缘）
    radius: 65,
    // 摇杆头相对面板左上角的居中偏移（面板 100px、摇杆头 30px）
    centerOffset: 50,
};
export const COLORS = ['#fff', '#ff9797', '#97eaff', '#97ffbe', '#f4ff97', '#ffb797'];
export const MAP_IMAGE_SRC = './assets/img/bg.jpg';
