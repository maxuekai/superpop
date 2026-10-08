// 简单矩形。目前只当"带 4 个字段的数据盒"用（相机视口/世界范围）。
// within / overlaps 曾是相机钳制的实现，改成纯算术后就没人再调了——
// 由 scripts/check.js 的"未使用导出"检查抓出来删掉的。
export class Rectangle {
    constructor(left = 0, top = 0, width = 0, height = 0) {
        this.set(left, top, width, height);
    }

    set(left, top, width = this.width, height = this.height) {
        this.left = left;
        this.top = top;
        this.width = width;
        this.height = height;
        this.right = this.left + this.width;
        this.bottom = this.top + this.height;
    }
}