<script setup lang="ts">
import { ref } from 'vue'
import {
  AlertTriangle,
  Columns3,
  Download,
  ExternalLink,
  FilePlus2,
  FolderDown,
  Github,
  GitBranch,
  GripVertical,
  Images,
  Layers3,
  Mail,
  MessageCircle,
  MessageSquare,
  PenLine,
  RefreshCw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  ZoomIn,
} from 'lucide-vue-next'
import { APP_VERSION, IS_DESKTOP_APP } from '../core/appInfo'
import { getSavePicker } from '../core/save'

const titleRef = ref<HTMLHeadingElement | null>(null)
const isDesktopApp = IS_DESKTOP_APP
const updateState = ref<'idle' | 'checking' | 'started' | 'error'>('idle')
const updateMessage = ref('')

const runtimeLabel = isDesktopApp ? '免安装 EXE · 本机服务' : '浏览器页面 · 本机处理'

const saveLocationLabel = getSavePicker()
  ? '系统保存对话框'
  : '浏览器默认下载目录'

const projectLinks = [
  {
    name: 'GitHub',
    handle: 'yisi-code/Yisi-Image',
    url: 'https://github.com/yisi-code/Yisi-Image',
    icon: Github,
  },
  {
    name: 'Gitee',
    handle: 'yisi-code/yisi-image',
    url: 'https://gitee.com/yisi-code/yisi-image',
    icon: GitBranch,
  },
]

const contacts = [
  { label: '开发者', value: '倚肆', href: '', icon: UserRound },
  { label: '微信', value: 'm1751250104', href: '', icon: MessageCircle },
  { label: 'QQ', value: '1751250104', href: '', icon: MessageSquare },
  {
    label: '邮箱',
    value: 'xiejing0520@petalmail.com',
    href: 'mailto:xiejing0520@petalmail.com',
    icon: Mail,
  },
]

const features = [
  {
    icon: Images,
    title: '多图导入',
    detail: '多选或直接拖入，支持 6 种常见格式',
  },
  {
    icon: Columns3,
    title: '纵向 / 横向',
    detail: '以最宽或最高图为画布，交叉轴居中',
  },
  {
    icon: SlidersHorizontal,
    title: '间距可调',
    detail: '0–200 px，滑块与数字输入同步',
  },
  {
    icon: GripVertical,
    title: '拖动排序',
    detail: '拖动卡片，或使用 Alt + ↑ / ↓',
  },
  {
    icon: ZoomIn,
    title: '缩放查看',
    detail: '50% 起，单张可占满视口；缩略图定位',
  },
  {
    icon: PenLine,
    title: '预览标注',
    detail: '文字、画笔、橡皮擦与局部修瑕；工具栏可拖动、收起',
  },
  {
    icon: FilePlus2,
    title: '空白页',
    detail: '插入白底页，输入尺寸或拖手柄调整',
  },
  {
    icon: Settings2,
    title: '缩略图设置',
    detail: '方向、大小、显示方式可调，连同间距存入配置文件',
  },
  {
    icon: FolderDown,
    title: '保存与恢复',
    detail: 'PNG / JPEG / WebP，导出后保留一次恢复快照',
  },
  {
    icon: Download,
    title: '检查更新',
    detail: '启动自动检查，也可在关于页或托盘手动检查',
  },
  {
    icon: RefreshCw,
    title: '自动安装',
    detail: '下载显示进度，校验后自动替换并重启',
  },
]

const shortcuts = [
  { keys: ['滚轮'], label: '缩放预览' },
  { keys: ['放大后拖动'], label: '平移查看' },
  { keys: ['+', '-'], label: '放大 / 缩小' },
  { keys: ['0', '双击'], label: '适应窗口' },
  { keys: ['↑', '↓', '←', '→'], label: '平移画面' },
  { keys: ['Alt', '↑', '↓'], label: '调整队列顺序' },
]

async function checkForUpdate(): Promise<void> {
  if (!isDesktopApp || updateState.value === 'checking') {
    return
  }

  updateState.value = 'checking'
  updateMessage.value = '正在打开检查窗口…'
  try {
    const response = await fetch('/api/update/check', {
      method: 'POST',
      headers: { 'X-Yisi-Update': '1' },
    })
    if (!response.ok) {
      throw new Error(`本地更新服务返回 ${response.status}`)
    }
    updateState.value = 'started'
    updateMessage.value = '已发起检查，请在弹出的窗口查看结果。'
  } catch (error) {
    updateState.value = 'error'
    updateMessage.value =
      error instanceof Error ? error.message : '无法连接本地更新服务，请稍后重试。'
  }
}

function focusTitle(): void {
  titleRef.value?.focus()
}

defineExpose({ focusTitle })
</script>

<template>
  <section class="about-page" aria-labelledby="about-title">
    <header class="about-hero">
      <span class="about-mark" aria-hidden="true">
        <Layers3 :size="24" :stroke-width="1.8" />
      </span>
      <div class="about-hero-copy">
        <div class="about-heading">
          <h2 id="about-title" ref="titleRef" tabindex="-1">关于 Yisi 图像工具</h2>
          <span class="about-version">v{{ APP_VERSION }}</span>
        </div>
        <p class="about-intro">
          一个在本地完成多图拼接、轻量标注和空白页排版的工具。纵向、横向、间距和顺序都能随手调整，
          预览缩放后逐张查看细节，导出时再选择保存位置。图片不离开这台电脑。
        </p>
      </div>
    </header>

    <section class="about-section" aria-labelledby="about-basic-title">
      <h3 id="about-basic-title">基本信息</h3>
      <dl class="about-facts">
        <div class="about-fact">
          <dt>运行方式</dt>
          <dd>{{ runtimeLabel }}</dd>
        </div>
        <div class="about-fact">
          <dt>技术栈</dt>
          <dd>Vue 3 · TypeScript · Vite</dd>
        </div>
        <div class="about-fact">
          <dt>绘制方式</dt>
          <dd>Canvas 2D · 本机处理</dd>
        </div>
        <div class="about-fact">
          <dt>EXE 外壳</dt>
          <dd>C# · .NET Framework 4.8</dd>
        </div>
        <div class="about-fact">
          <dt>保存位置</dt>
          <dd>{{ saveLocationLabel }}</dd>
        </div>
        <div class="about-fact">
          <dt>输出格式</dt>
          <dd>PNG / JPEG / WebP · 原图尺寸 · 白底</dd>
        </div>
        <div class="about-fact">
          <dt>更新来源</dt>
          <dd>GitHub / Gitee Release</dd>
        </div>
        <div class="about-fact">
          <dt>更新方式</dt>
          <dd>启动检查 · 下载进度 · SHA-256 校验</dd>
        </div>
      </dl>
    </section>

    <section class="about-section" aria-labelledby="about-update-title">
      <div class="about-update-head">
        <h3 id="about-update-title">软件更新</h3>
        <span class="about-update-badge">自动检查已开启</span>
      </div>
      <p class="about-update-copy">
        启动后自动检查更新，最多每 24 小时一次。下载会显示进度并校验 SHA-256，
        通过后由安装器替换并重启；浏览器页面不能直接覆盖 EXE。
      </p>
      <div v-if="isDesktopApp" class="about-update-actions">
        <button
          type="button"
          class="about-update-button"
          :disabled="updateState === 'checking'"
          @click="checkForUpdate"
        >
          <RefreshCw :size="13" :stroke-width="1.9" aria-hidden="true" />
          {{ updateState === 'checking' ? '正在检查…' : '立即检查更新' }}
        </button>
        <span
          v-if="updateMessage"
          class="about-update-status"
          :class="{ 'about-update-status--error': updateState === 'error' }"
          role="status"
        >
          {{ updateMessage }}
        </span>
      </div>
      <p v-else class="about-update-note">更新检查与安装仅在免安装 EXE 中可用。</p>
    </section>

    <section class="about-section" aria-labelledby="about-features-title">
      <h3 id="about-features-title">功能范围</h3>
      <ul class="about-features">
        <li v-for="feature in features" :key="feature.title" class="about-feature">
          <span class="about-feature-icon" aria-hidden="true">
            <component :is="feature.icon" :size="14" :stroke-width="1.9" />
          </span>
          <span class="about-feature-copy">
            <strong>{{ feature.title }}</strong>
            <span>{{ feature.detail }}</span>
          </span>
        </li>
      </ul>
    </section>

    <section class="about-section" aria-labelledby="about-shortcuts-title">
      <h3 id="about-shortcuts-title">预览快捷键</h3>
      <ul class="about-shortcuts">
        <li v-for="shortcut in shortcuts" :key="shortcut.label" class="about-shortcut">
          <span class="about-keys">
            <kbd v-for="key in shortcut.keys" :key="key">{{ key }}</kbd>
          </span>
          <span class="about-shortcut-label">{{ shortcut.label }}</span>
        </li>
      </ul>
    </section>

    <section class="about-section" aria-labelledby="about-contact-title">
      <h3 id="about-contact-title">项目与联系</h3>
      <div class="about-projects">
        <a
          v-for="project in projectLinks"
          :key="project.name"
          class="about-project-link"
          :href="project.url"
          target="_blank"
          rel="noreferrer"
        >
          <span class="about-project-icon" aria-hidden="true">
            <component :is="project.icon" :size="15" :stroke-width="1.9" />
          </span>
          <span class="about-project-copy">
            <strong>{{ project.name }}</strong>
            <span>{{ project.handle }}</span>
          </span>
          <ExternalLink class="about-project-arrow" :size="13" :stroke-width="1.8" aria-hidden="true" />
        </a>
      </div>

      <dl class="about-facts about-contact-facts">
        <div v-for="contact in contacts" :key="contact.label" class="about-fact">
          <dt>
            <component :is="contact.icon" :size="11" :stroke-width="1.9" aria-hidden="true" />
            {{ contact.label }}
          </dt>
          <dd>
            <a v-if="contact.href" :href="contact.href">{{ contact.value }}</a>
            <span v-else>{{ contact.value }}</span>
          </dd>
        </div>
      </dl>
    </section>

    <div class="about-columns">
      <section class="about-section" aria-labelledby="about-privacy-title">
        <h3 id="about-privacy-title">
          <ShieldCheck :size="14" :stroke-width="1.9" aria-hidden="true" />
          数据与隐私
        </h3>
        <ul class="about-list">
          <li>图片只在当前设备上用 Canvas 处理，不会上传到任何服务器。</li>
          <li>EXE 只监听本机 127.0.0.1:47831，不对外网开放。</li>
          <li>队列和恢复快照只存在内存中，刷新或关闭页面即清空。</li>
          <li>电脑里的原图不会被修改或删除，导出会另存为新文件。</li>
        </ul>
      </section>

      <section class="about-section" aria-labelledby="about-limits-title">
        <h3 id="about-limits-title">
          <AlertTriangle :size="14" :stroke-width="1.9" aria-hidden="true" />
          已知限制
        </h3>
        <ul class="about-list">
          <li>
            系统保存对话框依赖 Chromium 浏览器；其他浏览器会回退到默认下载目录。
          </li>
          <li>
            单边超过 16,384 px 或总面积超过 1 亿像素时禁止导出；超过 6,000 万像素会提示可能较慢。
          </li>
          <li>GIF 只使用第一帧；视频、独立裁剪和滤镜不在本工具范围。</li>
          <li>局部修瑕是模糊附近画面，不是内容感知移除；标注提交后暂不支持再次选中或拖动。</li>
          <li>只保留最近一次清空的快照；刷新或关闭页面会释放，超大图片请留意内存。</li>
          <li>
            免安装 EXE 未签名，首次运行可能触发 SmartScreen；需要 Windows 自带的 .NET Framework 4.8。
          </li>
        </ul>
      </section>
    </div>

    <footer class="about-footer">
      <span>Yisi 图像工具 · v{{ APP_VERSION }}</span>
      <span>使用中遇到问题，请附上截图和操作步骤联系工具维护者。</span>
    </footer>
  </section>
</template>

<style scoped>
.about-page {
  display: flex;
  width: 100%;
  max-width: 940px;
  flex-direction: column;
  gap: 16px;
  margin: 0 auto;
}

.about-hero {
  display: flex;
  align-items: flex-start;
  gap: 18px;
  padding: 24px 26px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: linear-gradient(135deg, var(--surface) 0%, var(--surface-accent) 100%);
  box-shadow: var(--shadow-panel);
}

.about-mark {
  display: inline-flex;
  width: 52px;
  height: 52px;
  flex: 0 0 52px;
  align-items: center;
  justify-content: center;
  border-radius: 15px;
  background: linear-gradient(145deg, var(--brand-start), var(--brand-end));
  color: var(--surface);
  box-shadow: var(--shadow-xs);
}

.about-hero-copy {
  min-width: 0;
}

.about-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
}

.about-heading h2 {
  color: var(--text-strong);
  font-size: 22px;
  font-weight: 680;
  letter-spacing: -0.025em;
  line-height: 1.25;
}

.about-heading h2:focus {
  outline: none;
}

.about-version {
  padding: 3px 8px;
  border: 1px solid var(--accent-line);
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 10.5px;
  font-weight: 650;
  line-height: 1.3;
}

.about-intro {
  max-width: 720px;
  margin-top: 9px;
  color: var(--text-muted);
  font-size: 12.5px;
  line-height: 1.75;
}

.about-section {
  padding: 19px 22px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: var(--shadow-xs);
}

.about-section h3 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 13px;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 650;
  letter-spacing: -0.006em;
}

.about-section h3 svg {
  color: var(--accent);
}

.about-facts {
  display: grid;
  overflow: hidden;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  margin: 0;
  border: 1px solid var(--border-subtle);
  border-radius: 9px;
  background: var(--border-subtle);
}

.about-fact {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
  padding: 10px 13px;
  background: var(--surface);
}

.about-fact dt {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 550;
}

.about-fact dt svg {
  flex: 0 0 auto;
  color: var(--accent);
}

.about-fact dd {
  overflow: hidden;
  margin: 0;
  color: var(--text-strong);
  font-size: 11.5px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.about-fact dd a {
  color: var(--accent-ink);
  text-decoration: none;
}

.about-fact dd a:hover {
  text-decoration: underline;
}

.about-update-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 9px;
}

.about-update-head h3 {
  margin: 0;
}

.about-update-badge {
  flex: 0 0 auto;
  padding: 3px 8px;
  border: 1px solid var(--accent-line);
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 10px;
  font-weight: 600;
}

.about-update-copy {
  max-width: 760px;
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 1.7;
}

.about-update-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}

.about-update-button {
  display: inline-flex;
  height: 30px;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  border: 1px solid var(--accent-line-strong);
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font: inherit;
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background-color 0.15s var(--ease),
    border-color 0.15s var(--ease);
}

.about-update-button:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--surface-accent);
}

.about-update-button:disabled {
  cursor: wait;
  opacity: 0.64;
}

.about-update-status,
.about-update-note {
  color: var(--text-faint);
  font-size: 10.5px;
  line-height: 1.5;
}

.about-update-status--error {
  color: var(--danger);
}

.about-projects {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 10px;
}

.about-project-link {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
  padding: 10px 11px;
  border: 1px solid var(--border-subtle);
  border-radius: 9px;
  background: var(--surface-subtle);
  color: var(--text);
  text-decoration: none;
  transition:
    border-color 0.15s var(--ease),
    background-color 0.15s var(--ease);
}

.about-project-link:hover {
  border-color: var(--accent-line-strong);
  background: var(--surface-accent);
}

.about-project-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.about-project-icon {
  display: inline-flex;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  background: var(--accent-soft);
  color: var(--accent);
}

.about-project-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}

.about-project-copy strong {
  color: var(--text-strong);
  font-size: 11.5px;
  font-weight: 650;
}

.about-project-copy span {
  overflow: hidden;
  color: var(--text-faint);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.about-project-arrow {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--text-faint);
}

.about-project-link:hover .about-project-arrow {
  color: var(--accent);
}

.about-contact-facts {
  margin-top: 10px;
}

.about-features {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.about-feature {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 11px;
  border: 1px solid var(--border-subtle);
  border-radius: 9px;
  background: var(--surface-subtle);
}

.about-feature-icon {
  display: inline-flex;
  width: 26px;
  height: 26px;
  flex: 0 0 26px;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  background: var(--accent-soft);
  color: var(--accent);
}

.about-feature-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.about-feature-copy strong {
  color: var(--text-strong);
  font-size: 11.5px;
  font-weight: 650;
}

.about-feature-copy > span {
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.45;
}

.about-shortcuts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px 18px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.about-shortcut {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--border-subtle);
}

.about-shortcut:nth-last-child(-n + 2) {
  border-bottom: 0;
}

.about-keys {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.about-keys kbd {
  min-width: 22px;
  padding: 2px 6px;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  background: var(--surface-subtle);
  box-shadow: 0 1px 0 var(--border-strong);
  color: var(--text);
  font-family: inherit;
  font-size: 10px;
  line-height: 1.4;
  text-align: center;
}

.about-shortcut-label {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-size: 10.5px;
  text-align: right;
}

.about-columns {
  display: grid;
  grid-template-columns: minmax(0, 1.06fr) minmax(0, 0.94fr);
  gap: 16px;
}

.about-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding-left: 16px;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.65;
}

.about-list li::marker {
  color: var(--accent-line-strong);
}

.about-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 6px 18px;
  padding: 2px 3px 0;
  color: var(--text-faint);
  font-size: 10px;
}

@media (max-width: 860px) {
  .about-features {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .about-columns {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
  .about-page {
    gap: 11px;
  }

  .about-hero {
    gap: 13px;
    padding: 18px 16px;
  }

  .about-mark {
    width: 42px;
    height: 42px;
    flex-basis: 42px;
    border-radius: 12px;
  }

  .about-heading h2 {
    font-size: 19px;
  }

  .about-intro {
    font-size: 12px;
  }

  .about-section {
    padding: 16px;
  }

  .about-facts,
  .about-features,
  .about-shortcuts,
  .about-projects {
    grid-template-columns: minmax(0, 1fr);
  }

  .about-shortcut {
    border-bottom: 1px dashed var(--border-subtle);
  }

  .about-shortcut:nth-last-child(-n + 2) {
    border-bottom: 1px dashed var(--border-subtle);
  }

  .about-shortcut:last-child {
    border-bottom: 0;
  }

  .about-footer {
    flex-direction: column;
    gap: 4px;
  }
}
</style>
