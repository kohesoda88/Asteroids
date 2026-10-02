// 画面（ビュー）は正方形。自機を中心に、前方が上になるよう描く
export const VIEW_SIZE = 800;
// フィールドは画面の面積4倍（一辺2倍）。端は反対側につながる
export const WORLD_W = VIEW_SIZE * 2;
export const WORLD_H = VIEW_SIZE * 2;

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export const MAX_PLAYERS = 4;

// 入力ビット
export const IN_LEFT = 1;
export const IN_RIGHT = 2;
export const IN_THRUST = 4;
export const IN_FIRE = 8;

// 船
export const SHIP_RADIUS = 11;
export const SHIP_TURN_SPEED = 1.55; // rad/s（約89°/秒。1周に約4秒）
export const SHIP_THRUST = 420; // px/s^2
export const SHIP_DRAG = 0.055; // 速度の指数減衰率 (1/s)。推進を止めても長く滑る
export const SHIP_MAX_SPEED = 460;
export const SHIP_FIRE_COOLDOWN = 0.18;
export const SHIP_MAX_BULLETS = 4;
export const SHIP_RESPAWN_TIME = 2;
export const SHIP_INVULN_TIME = 3;

// 弾
export const BULLET_SPEED = 620;
// 射程は画面の見えている範囲（中心から画面の端まで＝一辺の半分）
export const BULLET_RANGE = VIEW_SIZE / 2;
export const BULLET_LIFE = BULLET_RANGE / BULLET_SPEED;

// 小惑星（size: 3=大, 2=中, 1=小）
export const ROCK_RADIUS: Record<number, number> = { 3: 42, 2: 22, 1: 11 };
export const ROCK_SPEED: Record<number, [number, number]> = { 3: [30, 70], 2: [50, 110], 1: [70, 150] };
export const ROCK_POINTS: Record<number, number> = { 3: 20, 2: 50, 1: 100 };
export const WAVE_DELAY = 2;
export const ROCK_COUNT_SCALE = 2; // 広いフィールドに合わせて小惑星を約2倍にする
export const MAX_WAVE_ROCKS = 11 * ROCK_COUNT_SCALE;
export const ROCK_SPAWN_CLEARANCE = 600; // 船から少なくともこの距離（画面の外）に出す

// UFO
export const UFO_RADIUS = { large: 18, small: 10 };
export const UFO_SPEED = { large: 90, small: 130 };
export const UFO_FIRE_INTERVAL = { large: 1.3, small: 1.0 };
export const UFO_POINTS = { large: 200, small: 1000 };
export const UFO_SPAWN_MIN = 12;
export const UFO_SPAWN_MAX = 25;
export const UFO_BULLET_SPEED = 380;
export const UFO_BULLET_LIFE = BULLET_RANGE / UFO_BULLET_SPEED;

// 対戦
export const PLAYER_KILL_POINTS = 200;
export const DEFAULT_DURATION_SEC = 180;

// ソロ
export const SOLO_LIVES = 3;
export const EXTRA_LIFE_EVERY = 10000;

// プレイヤー色
export const PLAYER_COLORS = ['#4de8ff', '#ff5fa8', '#ffd84d', '#7dff6a'];
export const UFO_COLOR = '#ff6b4d';
