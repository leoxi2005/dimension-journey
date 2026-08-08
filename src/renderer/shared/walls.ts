// ============================================================================
// Hình học 5 MẶT TƯỜNG của phòng pentagon Bali.
//
// Khung 10350×1080 KHÔNG phải một mặt phẳng liền — nó là 5 mặt tường ghép lại,
// mỗi mặt do một máy chiếu warp riêng bên Resolume. Số đo thật: rộng
// 180 / 560 / 440 / 500 / 620 cm, đều cao 240 cm, quy ra đồng nhất 4.5 px/cm.
// (Cùng phòng với Door Portals — số chốt ở ~/door-portals/HANDOFF.md.)
//
// Hệ quả cho mọi thứ vẽ lên khung này:
// - Chữ vắt qua mối nối là GÃY LÀM ĐÔI ở góc phòng, không đọc được từ chỗ nào cả.
// - Muốn "phủ đủ 5 tường" thì phải rải theo ĐÚNG các mặt này, chứ rải ngẫu nhiên
//   trên 10350px thì mặt rộng 620cm hứng gấp 3.4 lần mặt rộng 180cm, và mặt hẹp
//   nhất có lúc trống trơn.
// ============================================================================

export const WALL_PX = [810, 2520, 1980, 2250, 2790]
export const WALL_COUNT = WALL_PX.length
const TOTAL_PX = WALL_PX.reduce((a, b) => a + b, 0)

export interface WallSpan {
  /** Mép trái, tỉ lệ 0..1 của tổng bề ngang. */
  x0: number
  /** Bề rộng, tỉ lệ 0..1. */
  w: number
  /** Tâm mặt tường, tỉ lệ 0..1. */
  mid: number
}

/** Mép trái + bề rộng của mặt tường thứ i (0-based), dưới dạng TỈ LỆ 0..1.
 *  Dùng tỉ lệ chứ không px tuyệt đối: cửa sổ preview lúc dev chỉ rộng vài trăm
 *  px, còn bản đẩy vào NDI mới là 10350 — cả hai phải ra cùng một bố cục. */
export function wallSpan(i: number): WallSpan {
  const k = ((i % WALL_COUNT) + WALL_COUNT) % WALL_COUNT
  let before = 0
  for (let j = 0; j < k; j++) before += WALL_PX[j]
  const w = WALL_PX[k] / TOTAL_PX
  const x0 = before / TOTAL_PX
  return { x0, w, mid: x0 + w / 2 }
}

/** Mặt tường đang chứa điểm ở tỉ lệ x (0..1). */
export function wallAt(x: number): number {
  let acc = 0
  for (let i = 0; i < WALL_COUNT; i++) {
    acc += WALL_PX[i] / TOTAL_PX
    if (x < acc) return i
  }
  return WALL_COUNT - 1
}
