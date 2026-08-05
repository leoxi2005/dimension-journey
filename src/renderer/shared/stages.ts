// Nội dung 6 chiều — giữ NGUYÊN VĂN từ bản prototype, cả Control và Wall dùng chung.
export interface StageInfo {
  key: string
  title: string
  caption: string
  hint: string
}

export const STAGES: StageInfo[] = [
  { key: '0D', title: 'the point', caption: 'no size, no space. pure potential. a single spark of awareness before anything exists.', hint: 'draw in the air — every trace dissolves. only the point remains.' },
  { key: '1D', title: 'the line', caption: 'length only. two points, connected. the first stretch into form.', hint: 'whatever you draw collapses into a straight line.' },
  { key: '2D', title: 'the plane', caption: 'flatland — width, no height. a being living here cannot even imagine "up."', hint: 'draw freely — everything lives flat on the plane.' },
  { key: '3D', title: 'space. matter.', caption: 'height, volume, "solid" things. the world of the body, the avatar, the stuff.', hint: 'your strokes solidify into volume. space slowly turns.' },
  { key: '4D', title: 'time. mind.', caption: 'the dimension that lets 3D move and change. one form, echoing across spacetime.', hint: 'draw once — your form appears across spacetime.' },
  { key: '5D', title: 'the field', caption: 'beyond linear time. all potentials, all layers, all versions — existing now, at once.', hint: 'each drawing stacks as a new layer. open palm to turn the field.' }
]
