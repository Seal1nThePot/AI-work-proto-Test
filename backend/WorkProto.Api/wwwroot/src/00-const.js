// ────────── 00-const.js ──────────「常量」
// 用途: 常量：状态色与文案表、节点/链/端口几何、视口缩放范围、底纹步长、吸附阈值、SVG 命名空间
// 暴露: STATUS_COLORS STATUS_TEXT MODE_TEXT NODE_W NODE_H COMPACT_W COMPACT_H CHAIN_W CHAIN_H CHAIN_FRAME_MIN NODE_GAP_X NODE_GAP_Y PORT_R PORT_HIT MIN_SCALE MAX_SCALE GRID_STEP SNAP_PX DRAG_START SVG_NS
// 依赖: 无
// 被依赖: 01/02/03 与 app.js 全部下游脚本

const STATUS_COLORS = {
  pending: "#6b7280",
  active: "#2563eb",
  review: "#a855f7",
  approved: "#16a34a",
  blocked: "#dc2626",
  skipped: "#94a3b8"
};
const STATUS_TEXT = {
  pending: "待开始",
  active: "进行中",
  review: "待审",
  approved: "已完成",
  blocked: "阻塞·等人",
  skipped: "不需要做"
};
const MODE_TEXT = { all: "全等", any: "任一", k_of_n: "K-of-N", pick_one: "择一" };

const NODE_W = 214;
const NODE_H = 88;
const COMPACT_W = 140;     // 收纳后的窄卡片：只放标题或关键字
const COMPACT_H = 40;
const CHAIN_W = 246;       // 同向链收成一块时的宽卡片（跟节点同高，连线照样对得上）
const CHAIN_H = 88;
const CHAIN_FRAME_MIN = 3; // 摊开时只给「三节以上」的链画虚线框，两节的画框太吵
const NODE_GAP_X = 96;
const NODE_GAP_Y = 34;
const PORT_R = 7;
const PORT_HIT = 14;
const MIN_SCALE = 0.2;
const MAX_SCALE = 2.5;
const GRID_STEP = 24;      // 底纹一格＝世界坐标 24px；画布没边，格子跟着视口走
const SNAP_PX = 12;        // Shift 拖动时的吸附阈值（世界坐标 px）
const DRAG_START = 3;      // 手抖不到 3px 不算拖动：不然「点一下」会被吞成拖动
const SVG_NS = "http://www.w3.org/2000/svg";
