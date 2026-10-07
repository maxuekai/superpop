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

        this.splitBtn = root.querySelector('.division');
        this.splitLabel = root.querySelector('.division-label');
        this.lastSplitLabel = '';

        this.menuBtn = root.querySelector('.menu-btn');

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
        const fire = () => {
            this.releaseFocus();
            handler(this.readName(this.startInput));
        };
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
        const fire = () => {
            this.releaseFocus();
            handler(this.readName(this.respawnInput));
        };
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

    // 点完"开始游戏"/"再来一局"后要把焦点从按钮、输入框上摘掉：
    // 焦点还留在弹层里时 keydown 的 target 是弹层内的元素，而 KEYS.ignoreTarget
    // 里含 .ui-interactive → 会被当成"正在输入框里打字"，第一个按下的游戏键
    // （尤其是分裂的空格）被直接丢掉。弹层随后是 display:none，浏览器一般会自动
    // 把焦点还给 body，但不该依赖这个行为。
    releaseFocus() {
        const doc = (this.startBtn && this.startBtn.ownerDocument) || null;
        const active = doc && doc.activeElement;
        if (active && typeof active.blur === 'function') {
            active.blur();
        }
    }

    // 分裂按钮：手机端主要入口（桌面还可以按空格）
    //
    // 用 pointerdown 而不是 click：click 是浏览器从 touch 合成的，而摇杆一有活跃手指
    // （一边拖动一边想按分裂），多指手势下这个合成 click 经常不触发——真机反馈
    // "分裂还是不能一边移动一边分裂"。pointerdown 在手指按下的瞬间就派发，不经过
    // 合成，也不受摇杆在 touchmove 上 preventDefault 的影响。
    // click 保留作为兜底；两个入口都走 requestSplit，它自带 8s 冷却，
    // 重复触发会被自己挡掉，不会分裂两次。
    onSplit(handler) {
        if (!this.splitBtn) {
            return;
        }
        this.splitBtn.addEventListener('pointerdown', (e) => {
            // 不要 preventDefault：会连带屏蔽 click，也影响按钮的 :active 反馈
            handler(e);
        });
        this.splitBtn.addEventListener('click', handler);
    }

    // 分裂按钮的可用态与冷却文案。
    // 只有「真能分裂」时才显示可点状态——以前这个按钮一直摆在那儿，
    // 玩家按了没反应又容易误触，才被移除；现在长到阈值才亮。
    // 冷却期间必须真的 disabled：只改样式的话按钮照样能点，点下去 requestSplit
    // 直接 return false，玩家只会看到"按了没反应"，分不清是冷却还是没到门槛。
    updateSplit(state) {
        if (!this.splitBtn) {
            return;
        }
        const cooling = state.cooldownLeft > 0.05;
        this.splitBtn.classList.toggle('ready', state.canSplit);
        this.splitBtn.classList.toggle('cooling', !state.canSplit && cooling);
        this.splitBtn.classList.toggle('hidden', !state.canSplit && !cooling);
        this.splitBtn.disabled = !state.canSplit;
        if (this.splitLabel) {
            const label = state.canSplit ? '分裂' : `${Math.ceil(state.cooldownLeft)}s`;
            if (label !== this.lastSplitLabel) {
                this.lastSplitLabel = label;
                this.splitLabel.textContent = label;
            }
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
        this.updateWeight(game.playerMass());
        this.renderLeaderboard(game.leaderboard());
        this.updateSplit(game.splitState());
        // 菜单按钮只在局内出现：弹层期间它露在边缘会很难看
        if (this.menuBtn) {
            this.menuBtn.classList.toggle('hidden', game.state !== 'playing');
        }
    }

    // 体重面板 = 玩家整组质量（分身的质量之和）
    updateWeight(mass) {
        if (this.weightEl === null) {
            return;
        }
        const weight = Math.round(mass);
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

    // 菜单按钮：结束本局回到开局界面（球长得太大、想收手时用）
    // 同样走 pointerdown，理由见 onSplit。
    onMenu(handler) {
        if (!this.menuBtn) {
            return;
        }
        this.menuBtn.addEventListener('pointerdown', (e) => {
            this.releaseFocus();
            handler(e);
        });
        this.menuBtn.addEventListener('click', (e) => {
            this.releaseFocus();
            handler(e);
        });
    }

    // 重新显示开局界面（从菜单回来时用）
    showStart() {
        if (this.settlementOverlay) {
            this.settlementOverlay.classList.add('hidden');
        }
        if (this.startOverlay) {
            this.startOverlay.classList.remove('hidden');
        }
    }

    hideSettlement() {
        if (this.settlementOverlay) {
            this.settlementOverlay.classList.add('hidden');
        }
    }
}