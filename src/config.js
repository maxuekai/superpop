// 全局游戏常量
export const WORLD = { width: 1024, height: 768 };

// 固定步长：逻辑按 60Hz 推进，渲染跟随屏幕刷新率。
// 避免 120Hz 手机上「每帧位移/每帧弹簧」导致球速翻倍、手感变硬。
export const TICK = { fps: 60, maxSteps: 5 };

// 视野：屏幕上较长的一条边对应多少世界单位（类似缩放级别的锚点）。
// 实际渲染时会取「按此换算的缩放」和「窗口能装下整张地图的缩放」中较大的一个，
// 保证视口永远不超过世界大小（否则相机钳制会出问题）。
// zoomExponent：视野随体型的缩放指数——半径翻倍，视距变为 2^zoomExponent 倍。
export const VIEW = { longEdgeWorld: 900, zoomExponent: 0.35 };

// 食物：count 颗、半径 radius，成簇生成（clusterSize 颗/簇，簇半径 clusterRadius）。
// 成簇是因为散点太难点——单颗食物在手机上只有几个像素，散开时等于「擦身而过」。
export const FOOD = {
    count: 360,
    radius: 3,
    avoidGap: 40,
    clusterSize: 5,
    clusterRadius: 46,
};

// 分裂：一个球可以切成多个「细胞」，同属一个 owner。
// 质量守恒（分裂只是把质量对半分，不凭空产生），同一 owner 的细胞之间不能互吃；
// 冷却结束前不能再分，细胞靠拢到一定距离会自动合并回去。
export const SPLIT = {
    // 半径小于这个值的细胞不能再分（避免切出一堆小渣）
    minCellRadius: 16,
    cooldown: 8, // 两次分裂之间的间隔（秒）
    mergeCooldown: 3, // 分裂后多久才允许重新合并（秒），防止切完立刻粘回去
    mergeFactor: 0.9, // 两细胞中心距 < (r1+r2) × 该值时合并
    maxCells: 8, // 场上最多同时存在多少个自己的细胞
};

// 键盘/按钮都能触发的动作键
export const ACTIONS = { split: ['Space'] };

// 玩家与 AI 共用的移动/成长参数（Ball 基类统一读取）
export const PLAYER = {
    radius: 10,
    // speedX/speedY 每帧除以该值，相当于速度分母。
    // 60 时满速 70 单位/秒、跨屏要 12.9 秒，实测偏慢；改成 50 → 84 单位/秒、10.7 秒
    speedDivisor: 50,
    // 每吃一颗食物半径增长量
    growthPerFood: 0.5,
    // 半径每比初始大 1，速度分母增加多少（越大越慢，大球有"沉重感"）
    // 1.2 时 r=50 只剩初始速度的 56%、跨屏 23 秒，太黏；0.9 → 58% / 18.4 秒
    slowdownPerRadius: 0.9,
    // 吃到食物的视觉回弹：弹簧刚度/阻尼（每步），以及吃到时给视觉半径的速度增量
    springStiffness: 0.16,
    springDamping: 0.7,
    pulseKick: 0.8,
    // 重生后的无敌时间（秒）：出生保护，期间不会被吃，外面画一圈光环
    spawnShield: 2.5,
    // 速度标定：摇杆/AI 写入的是「摇杆像素量」，除以速度分母后再乘以该系数换算成世界单位/秒
    // 60 表示 60fps 时的行为与旧版每帧实现完全一致
    speedUnit: 60,
};

// 互吃规则：质量按 r² 计（体重面板也是 r²）
export const EAT = {
    // 半径比阈值：只有大于对方 ratio 倍才吃得掉，避免势均力敌时反复互吞
    ratio: 1.15,
    // 吃到的质量里能吸收的比例（其余散落掉）
    absorb: 0.85,
};

export const AI = {
    // 同屏 AI 数量区间：随玩家体型在 minCount ~ count 之间动态调整
    minCount: 6,
    count: 12,
    // AI 每吃一颗食物的半径收益。食物变多之后 AI 也会吃得更快，
    // 用这个值把它们的成长速度按回来（实测 AI.foodGain=0.3 时 30 秒从 100kg 长到 ~1000kg）
    foodGain: 0.3,
    // 数量校准间隔（秒）
    syncInterval: 2,
    // 出生/重生半径：在 [spawnRadiusMin, spawnRadiusMax] × 初始半径 的区间里随机，
    // 上限取「玩家当前半径 × 比例」——玩家小的时候满屏都是小球（玩家有猎物可追），
    // 玩家大了以后才会出现真正的大球
    spawnRadiusMin: 0.8,
    spawnRadiusMax: 2.2,
    spawnRadiusRatio: 1.05,
    respawnRadiusRatio: 0.95,
    // 被吃后重生延迟（秒）
    respawnDelay: 3,
    // 重生后的无敌时间（秒），比玩家短一点
    respawnShield: 1.5,
    // 转向速度（相对摇杆满舵），逃跑时全速
    speedScale: 0.92,
    // 重新决策间隔（秒）；转向每帧算，避免迟钝
    thinkInterval: 0.2,
    // 逃离时不再沿「远离威胁」直线冲（会被逼到墙角撞死），
    // 而是从 escapeSamples 个均分方向里挑最优：离威胁更远、又不贴墙、不扎进别的球
    escapeSamples: 16,
    // 候选方向的探测距离（世界单位）。它要跟得上速度：速度提上去后若不补偿，
    // AI 看不见远处的墙角，贴墙比例会从 1% 飙到 11%（divisor=50 时的实测）
    escapeProbe: 180,
    escapeWallWeight: 1, // 贴墙惩罚权重（越大越不敢靠边）
    escapeBallWeight: 1.2, // 撞向别的球的惩罚权重
    escapeBallGap: 26, // 与别的球保持的额外间距
    escapeChange: 0.25, // 每次重新决策时换一套方向偏好的概率，避免 AI 动作千篇一律
    // 逃跑时离多远以内的食物会顺手去吃（世界单位），0 = 逃跑时完全不觅食
    escapeFoodRange: 90,
    // 食物对逃跑方向的吸引权重：要远小于威胁/贴墙的惩罚项，
    // 保证「为了吃一口把自己送回危险里」不会发生。
    // 0.25 会把被逼墙比例从 1.3% 拉到 8.7%，0.1 是实测平衡点（见 npm run sim）
    escapeFoodWeight: 0.1,
    // 追击时瞄猎物前方 chaseLead 秒后的位置（0 = 只追当前坐标）
    chaseLead: 0.25,
    // 追击更小球 / 逃离更大球的判定距离（世界单位）
    // fleeRange 是手感关键：太大则 AI 一看见你就全程逃、永远吃不到人；太小则 AI 懒得躲
    chaseRange: 560,
    fleeRange: 160,
    // 没有目标时的随机游走间隔（秒）
    wanderInterval: 1.2,
    // 距世界边界该值以内开始往回躲
    borderMargin: 130,
};

export const JOYSTICK = {
    // 摇杆面板半径（拖动超出该距离摇杆头停在边缘）
    radius: 70,
    // 摇杆头相对面板左上角的居中偏移 = 面板直径/2（面板 140px）
    centerOffset: 70,
    // 死区：手指位移小于该值视为没动（避免手抖导致漂移）
    deadZone: 5,
};

// 键盘操作：WASD / 方向键。和摇杆一样把「摇杆像素量」写进 player.speedX/speedY，
// 所以键盘与触屏共用同一套速度分母和手感曲线。
export const KEYS = {
    up: ['KeyW', 'ArrowUp'],
    down: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
    // 按键力度：沿用摇杆满舵值，保证键盘全速和触屏全速一致
    power: JOYSTICK.radius,
    // 输入框/弹层里打字时不响应按键
    ignoreTarget: 'input, textarea, .ui-interactive',
};

// 玩家所属分组 id：同一 owner 的细胞之间不能互吃，排行榜按整组合计质量
export const PLAYER_OWNER = 'player';

// 出生点：距世界边缘至少留这么远，保证相机能把球放在屏幕中间
export const SPAWN = { edgeGap: 90 };

export const HUD = {
    // 排行榜显示前 N 名
    leaderboardSize: 8,
    // 排行榜/体重刷新间隔（秒）
    refreshInterval: 0.2,
};

export const NICKNAME = {
    defaultName: '我',
    maxLength: 10,
};

export const NAMES = ['小圆子', '肉松', '汤圆', '布丁', '麻薯', '芋圆', '奶盖', '泡芙', '雪媚娘', '双皮奶', '蛋挞', '糯米糍'];

export const COLORS = ['#fff', '#ff9797', '#97eaff', '#97ffbe', '#f4ff97', '#ffb797'];

export const MAP = { gridStep: 64 };