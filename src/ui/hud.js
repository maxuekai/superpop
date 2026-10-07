import { HUD, NICKNAME } from '../config.js';
import { formatTime } from '../core/utils.js';

// 页面 UI 层：体重面板、排行榜、开局界面、结算界面。
// 只做 DOM 读写和事件转发，玩法逻辑一律留在 Game 里。

// 昵称来自输入框，插进 innerHTML 前必须转义
function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export class Hud {
    constructor(root = document) {
        this.weightEl = root.querySelector('.weight');
        this.leaderboardEl = root.querySelector('.leaderboard-list');

        this.startOverlay = root.querySelector('.start-overlay');
        this.startInput = root.querySelector('.start-nickname');
        this.startBtn = root.querySelector('.start-btn');

        this.settlementOverlay = root.querySelector('.settlement-overlay');
        this.respawnInput = root.querySelector('.respawn-nickname');
        this.respawnBtn = root.querySelector('.respawn-btn');
        this.settleWeightEl = root.querySelector('.final-weight');
        this.settleRankEl = root.querySelector('.final-rank');
        this.settleTimeEl = root.querySelector('.final-time');
        this.settleDetailEl = root.querySelector('.final-detail');

        this.refreshTimer = 0;
        this.lastWeight = -1;
        this.lastBoard = '';

        for (const input of [this.startInput, this.respawnInput]) {
            if (input) {
                input.maxLength = String(NICKNAME.maxLength);
            }
        }
    }

    // ---------- 事件绑定 ----------

    onStart(handler) {
        const fire = () => handler(this.readName(this.startInput));
        if (this.startBtn) {
            this.startBtn.addEventListener('click', fire);
        }
        if (this.startInput) {
            this.startInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    fire();
                }
            });
        }
    }

    onRespawn(handler) {
        const fire = () => handler(this.readName(this.respawnInput));
        if (this.respawnBtn) {
            this.respawnBtn.addEventListener('click', fire);
        }
        if (this.respawnInput) {
            this.respawnInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    fire();
                }
            });
        }
    }

    readName(input) {
        if (!input) {
            return NICKNAME.defaultName;
        }
        const name = input.value.trim().slice(0, NICKNAME.maxLength);
        input.value = name;
        return name || NICKNAME.defaultName;
    }

    // ---------- 定时刷新 ----------

    update(dt, game) {
        this.refreshTimer -= dt;
        if (this.refreshTimer > 0) {
            return;
        }
        this.refreshTimer = HUD.refreshInterval;
        this.updateWeight(game.player);
        this.renderLeaderboard(game.leaderboard());
    }

    // 体重面板 = r² 取整
    updateWeight(ball) {
        if (this.weightEl === null) {
            return;
        }
        const weight = Math.round(ball.mass);
        if (weight === this.lastWeight) {
            return;
        }
        this.lastWeight = weight;
        this.weightEl.textContent = String(weight);
    }

    renderLeaderboard(entries) {
        if (this.leaderboardEl === null) {
            return;
        }
        const html = entries
            .map((item) => `<li class="leaderboard-item${item.isPlayer ? ' me' : ''}">`
                + `<span class="lb-rank">${item.rank}</span>`
                + `<span class="lb-name">${escapeHtml(item.name)}</span>`
                + `<span class="lb-weight">${item.weight}</span></li>`)
            .join('');
        // 排名没变就不动 DOM，避免每 0.2s 重建一次
        if (html === this.lastBoard) {
            return;
        }
        this.lastBoard = html;
        this.leaderboardEl.innerHTML = html;
    }

    // ---------- 弹层 ----------

    hideStart() {
        if (this.startOverlay) {
            this.startOverlay.classList.add('hidden');
        }
    }

    showSettlement(stats) {
        if (this.settleWeightEl) {
            this.settleWeightEl.textContent = String(stats.weight);
        }
        if (this.settleRankEl) {
            this.settleRankEl.textContent = String(stats.rank);
        }
        if (this.settleTimeEl) {
            this.settleTimeEl.textContent = formatTime(stats.time);
        }
        if (this.settleDetailEl) {
            this.settleDetailEl.textContent = `吃掉 ${stats.food} 颗食物 · 吞掉 ${stats.kills} 个球`;
        }
        if (this.respawnInput) {
            this.respawnInput.value = String(stats.name || '').slice(0, NICKNAME.maxLength);
        }
        if (this.settlementOverlay) {
            this.settlementOverlay.classList.remove('hidden');
        }
    }

    hideSettlement() {
        if (this.settlementOverlay) {
            this.settlementOverlay.classList.add('hidden');
        }
    }
}