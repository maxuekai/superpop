// 简单矩形，用于相机视口与世界范围的包含/相交判断
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

    // 完全包含另一个矩形
    within(rect) {
        return (
            rect.left <= this.left &&
            rect.right >= this.right &&
            rect.top <= this.top &&
            rect.bottom >= this.bottom
        );
    }

    // 与另一个矩形相交
    overlaps(rect) {
        return (
            this.left < rect.right &&
            rect.left < this.right &&
            this.top < rect.bottom &&
            rect.top < this.bottom
        );
    }
}
