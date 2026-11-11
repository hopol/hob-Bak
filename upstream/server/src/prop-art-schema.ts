import { Type } from "@earendil-works/pi-ai";

export const propArtSchema = Type.Optional(Type.Object({
  art: Type.Array(Type.String(), {
    description: "最多 16 行，每行恰好 16 个字符；从第 0 行起逐行盖在火苗上，. 表示不动，k 是描边色，其它字符查 pal；不能盖住火苗的两只眼睛",
  }),
  pal: Type.Record(Type.String(), Type.String(), {
    description: "单个小写字母 → #rrggbb；不能用 o y e（火苗自己的色）和 k（描边固定），最多 6 种",
  }),
  dx: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)], {
    description: "火苗的横向位置：头顶的道具用 2，手边的用 0 或 1",
  }),
}, {
  description: 'sprite 为 custom 时要画的那件。例：{ "art": ["....kkkk........", "...khhhhk.......", "....kkkk........"], "pal": { "h": "#ffc21a" }, "dx": 2 }',
}));
