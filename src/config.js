// 全局游戏常量
export const WORLD = { width: 1024, height: 768 };
// 视野：屏幕上较长的一条边对应多少世界单位（类似缩放级别的锚点）。
// 实际渲染时会取「按此换算的缩放」和「窗口能装下整张地图的缩放」中较大的一个，
// 保证视口永远不超过世界大小（否则相机钳制会出问题）。
// zoomExponent：视野随体型的缩放指数——半径翻倍，视距变为 2^zoomExponent 倍。
export const VIEW = { longEdgeWorld: 900, zoomExponent: 0.35 };
export const FOOD = { count: 200, radius: 2 };
export const PLAYER = {
    radius: 10,
    // speedX/speedY 每帧除以该值，相当于速度分母
    speedDivisor: 60,
    // 每吃一颗食物半径增长量
    growthPerFood: 0.5,
    // 半径每比初始大 1，速度分母增加多少（越大越慢，大球有"沉重感"）
    slowdownPerRadius: 1.2,
    // 吃到食物的视觉回弹：弹簧刚度/阻尼（每帧），以及吃到时给视觉半径的速度增量
    springStiffness: 0.16,
    springDamping: 0.7,
    pulseKick: 0.8,
};
export const JOYSTICK = {
    // 摇杆面板半径（拖动超出该距离摇杆头停在边缘）
    radius: 70,
    // 摇杆头相对面板左上角的居中偏移 = 面板直径/2（面板 140px）
    centerOffset: 70,
};
export const COLORS = ['#fff', '#ff9797', '#97eaff', '#97ffbe', '#f4ff97', '#ffb797'];
export const MAP = { gridStep: 64 };
