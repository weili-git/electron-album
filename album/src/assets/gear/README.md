# 设备官方产品图

「按设备」视图卡片头部的机身图，本地内置，不请求网络。

- 来源：Nikon 官方产品页，仅作个人本地展示使用；如需分发应用，请替换为有授权的素材。
  - Z 30：https://www.nikon.co.uk/en_GB/product/cameras/mirrorless/z-30
  - Z6III：https://prod.dxp.nikoneurope.com/en_GB/product/cameras/mirrorless/z6iii
- 统一处理：去除透明边后放入 480×360 透明画布，WebP（质量 90），卡片内按 `object-fit: contain` 显示。
- 命名：按归一化型号命名，匹配时忽略大小写、空格与标点；例如 `nikon-z30.webp` 可匹配 `NIKON Z 30`。差异较大的写法（如 EXIF 中的 `Z6_3` 与文件名 `z6iii`）在 `src/gearImages.ts` 的 `ALIASES` 中补充。
- 没有匹配到图片的机型回退到内联相机 SVG，不会报错。
