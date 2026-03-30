// ==UserScript==
// @name         免费整页翻译器 - 社交媒体专用
// @namespace    https://github.com/ucloud/translator
// @version      1.0.0
// @description  免费多 API 轮换翻译，支持 Twitter/YouTube/Instagram/Reddit/TikTok，无需付费
// @author       UCloud Assistant
// @match        https://twitter.com/*
// @match        https://x.com/*
// @match        https://www.youtube.com/*
// @match        https://www.instagram.com/*
// @match        https://www.reddit.com/*
// @match        https://www.tiktok.com/*
// @match        https://www.facebook.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @connect      translate.googleapis.com
// @connect      api.mymemory.translated.net
// @connect      api.deepl.com
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ==================== 配置区 ====================
    const CONFIG = {
        // 目标语言
        targetLang: 'zh-CN',
        
        // 自动检测语言阈值（置信度）
        detectThreshold: 0.7,
        
        // 翻译 API 列表（按优先级排序，全部免费）
        apis: [
            {
                name: 'Google Translate (免费)',
                url: 'https://translate.googleapis.com/translate_a/t',
                method: 'GET',
                enabled: true,
                weight: 100,
                request: (text, target) => ({
                    url: `https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=${target}&dt=t&q=${encodeURIComponent(text)}`,
                    method: 'GET'
                }),
                parse: (response) => {
                    try {
                        const data = JSON.parse(response);
                        return data[0].map(item => item[0]).join('');
                    } catch (e) {
                        return null;
                    }
                }
            },
            {
                name: 'MyMemory (免费，每日限制)',
                url: 'https://api.mymemory.translated.net/get',
                method: 'GET',
                enabled: true,
                weight: 80,
                request: (text, target) => ({
                    url: `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=auto|${target}`,
                    method: 'GET'
                }),
                parse: (response) => {
                    try {
                        const data = JSON.parse(response);
                        return data.responseData.translatedText;
                    } catch (e) {
                        return null;
                    }
                }
            }
        ],
        
        // 网站优先级配置
        sitePriority: {
            'twitter.com': 1,
            'x.com': 1,
            'youtube.com': 2,
            'instagram.com': 3,
            'reddit.com': 4,
            'tiktok.com': 5,
            'facebook.com': 6
        },
        
        // 需要翻译的元素选择器（按网站分类）
        selectors: {
            'twitter.com': [
                '[data-testid="tweetText"]',
                '[role="article"] span:not([aria-hidden="true"])',
                '[data-testid="cellInnerDiv"] span',
                'div[lang]'
            ],
            'youtube.com': [
                '#title h1',
                '#title yt-formatted-string',
                '#content-text',
                '#metadata-line span',
                'ytd-comment-renderer #content-text'
            ],
            'instagram.com': [
                'span._ap3a',
                'div.x1lliihq',
                'span._a9zs',
                'div.x9f619 span'
            ],
            'reddit.com': [
                'h3._1yk0u9j2',
                'div._1qeIAvB0cP1LwoUPVnU-5',
                'shreddit-comment p',
                'p.md'
            ],
            'tiktok.com': [
                'h2[data-e2e="video-desc"]',
                'span.css-1p9xnt9',
                'div.css-1qsxih2',
                'p.css-1xkks4v'
            ],
            'default': [
                'p',
                'span',
                'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                'div[role="article"]',
                'article',
                '[data-testid="content"]'
            ]
        },
        
        // 不翻译的选择器（避免破坏功能）
        excludeSelectors: [
            'script',
            'style',
            'noscript',
            'textarea',
            'input',
            'button',
            'code',
            'pre',
            '[class*="code"]',
            '[class*="emoji"]',
            '[aria-label]',
            '[title]'
        ],
        
        // 翻译选项
        translation: {
            // 最小文本长度（避免翻译单个字符）
            minLength: 3,
            // 最大文本长度（避免 API 限制）
            maxLength: 5000,
            // 批量翻译延迟（毫秒）
            batchDelay: 100,
            // 重试次数
            maxRetries: 3,
            // 重试延迟（毫秒）
            retryDelay: 1000
        }
    };

    // ==================== 状态管理 ====================
    let state = {
        enabled: true,
        currentApiIndex: 0,
        translatedElements: new WeakSet(),
        apiFailures: {},
        lastCheck: Date.now()
    };

    // ==================== 工具函数 ====================
    
    // 检测文本是否为外文（简单启发式）
    function isForeignText(text) {
        if (!text || text.length < CONFIG.translation.minLength) return false;
        
        // 中文字符检测
        const chineseRegex = /[\u4e00-\u9fff]/g;
        const chineseCount = (text.match(chineseRegex) || []).length;
        const chineseRatio = chineseCount / text.length;
        
        // 如果中文比例超过 70%，认为已经是中文
        if (chineseRatio > 0.7) return false;
        
        // 英文字母检测
        const latinRegex = /[a-zA-Z]/g;
        const latinCount = (text.match(latinRegex) || []).length;
        const latinRatio = latinCount / text.length;
        
        // 如果拉丁字母比例超过 30%，可能是外文
        return latinRatio > 0.3;
    }

    // 获取当前网站
    function getCurrentSite() {
        const host = window.location.hostname;
        return CONFIG.sitePriority[host] ? host : 'default';
    }

    // 获取网站优先级
    function getSitePriority() {
        const host = window.location.hostname;
        return CONFIG.sitePriority[host] || 999;
    }

    // ==================== 翻译核心 ====================
    
    // 翻译文本（带重试和 API 轮换）
    async function translateText(text, retryCount = 0) {
        if (!state.enabled) return text;
        if (retryCount >= CONFIG.translation.maxRetries) return text;

        const api = CONFIG.apis[state.currentApiIndex];
        if (!api.enabled) {
            state.currentApiIndex = (state.currentApiIndex + 1) % CONFIG.apis.length;
            return translateText(text, retryCount);
        }

        try {
            const requestConfig = api.request(text, CONFIG.targetLang);
            
            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    ...requestConfig,
                    timeout: 5000,
                    onload: (response) => {
                        const result = api.parse(response.responseText);
                        if (result) {
                            resolve(result);
                        } else {
                            throw new Error('解析失败');
                        }
                    },
                    onerror: () => {
                        // API 失败，切换到下一个
                        state.apiFailures[api.name] = (state.apiFailures[api.name] || 0) + 1;
                        state.currentApiIndex = (state.currentApiIndex + 1) % CONFIG.apis.length;
                        
                        if (state.currentApiIndex === 0) {
                            // 所有 API 都失败，等待后重试
                            setTimeout(() => {
                                resolve(translateText(text, retryCount + 1));
                            }, CONFIG.translation.retryDelay);
                        } else {
                            resolve(translateText(text, retryCount));
                        }
                    },
                    ontimeout: () => {
                        state.currentApiIndex = (state.currentApiIndex + 1) % CONFIG.apis.length;
                        resolve(translateText(text, retryCount));
                    }
                });
            });
        } catch (error) {
            console.log('[翻译器] 错误:', error);
            state.currentApiIndex = (state.currentApiIndex + 1) % CONFIG.apis.length;
            return translateText(text, retryCount + 1);
        }
    }

    // 翻译单个元素
    async function translateElement(element) {
        if (!element || state.translatedElements.has(element)) return;
        
        // 检查是否应该排除
        for (const exclude of CONFIG.excludeSelectors) {
            if (element.matches(exclude) || element.closest(exclude)) {
                return;
            }
        }

        const text = element.textContent?.trim();
        if (!text || !isForeignText(text)) return;

        // 标记为已翻译
        state.translatedElements.add(element);
        
        // 保存原文（用于切换）
        if (!element.dataset.originalText) {
            element.dataset.originalText = text;
        }

        try {
            const translated = await translateText(text);
            if (translated && translated !== text) {
                element.textContent = translated;
                element.dataset.translated = 'true';
                element.style.backgroundColor = 'rgba(0, 255, 0, 0.1)';
                setTimeout(() => {
                    element.style.backgroundColor = '';
                }, 1000);
            }
        } catch (error) {
            console.log('[翻译器] 翻译失败:', error);
        }
    }

    // 批量翻译页面元素
    async function translatePage() {
        if (!state.enabled) return;

        const site = getCurrentSite();
        const selectors = CONFIG.selectors[site] || CONFIG.selectors.default;
        
        console.log(`[翻译器] 开始翻译，网站：${site}`);

        for (const selector of selectors) {
            try {
                const elements = document.querySelectorAll(selector);
                for (const element of elements) {
                    await translateElement(element);
                    await new Promise(resolve => 
                        setTimeout(resolve, CONFIG.translation.batchDelay)
                    );
                }
            } catch (error) {
                console.log(`[翻译器] 选择器 ${selector} 错误:`, error);
            }
        }
    }

    // ==================== 监听器 ====================
    
    // 监听 DOM 变化（处理动态加载的内容）
    function observeDOM() {
        const observer = new MutationObserver((mutations) => {
            let shouldTranslate = false;
            
            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    shouldTranslate = true;
                    break;
                }
            }
            
            if (shouldTranslate) {
                translatePage();
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        console.log('[翻译器] DOM 监听已启动');
    }

    // ==================== 用户界面 ====================
    
    // 添加控制按钮
    function addControlButton() {
        const button = document.createElement('button');
        button.textContent = '🌐 翻译';
        button.style.cssText = `
            position: fixed;
            top: 10px;
            right: 10px;
            z-index: 999999;
            padding: 8px 16px;
            background: #1DA1F2;
            color: white;
            border: none;
            border-radius: 20px;
            cursor: pointer;
            font-size: 14px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
        `;
        
        button.onclick = () => {
            state.enabled = !state.enabled;
            button.textContent = state.enabled ? '🌐 翻译' : '⏸️ 已暂停';
            button.style.background = state.enabled ? '#1DA1F2' : '#666';
            GM_notification({
                text: state.enabled ? '翻译已启用' : '翻译已暂停',
                timeout: 2000
            });
        };

        document.documentElement.appendChild(button);
    }

    // 注册菜单命令
    function registerMenuCommands() {
        GM_registerMenuCommand('🔄 立即翻译当前页面', translatePage);
        GM_registerMenuCommand('⏯️ 切换翻译状态', () => {
            state.enabled = !state.enabled;
            GM_notification({
                text: state.enabled ? '翻译已启用' : '翻译已暂停',
                timeout: 2000
            });
        });
        GM_registerMenuCommand('📊 查看 API 状态', () => {
            let status = 'API 状态:\n';
            CONFIG.apis.forEach((api, index) => {
                const failures = state.apiFailures[api.name] || 0;
                const active = index === state.currentApiIndex ? '【当前】' : '';
                status += `${active} ${api.name}: 失败${failures}次\n`;
            });
            alert(status);
        });
        GM_registerMenuCommand('🗑️ 清除翻译历史', () => {
            state.translatedElements = new WeakSet();
            GM_notification({
                text: '翻译历史已清除',
                timeout: 2000
            });
        });
    }

    // ==================== 初始化 ====================
    
    function init() {
        console.log('[翻译器] 初始化...');
        console.log('[翻译器] 当前网站:', getCurrentSite());
        console.log('[翻译器] 优先级:', getSitePriority());

        // 等待页面加载
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                registerMenuCommands();
                addControlButton();
                observeDOM();
                setTimeout(translatePage, 1000);
            });
        } else {
            registerMenuCommands();
            addControlButton();
            observeDOM();
            setTimeout(translatePage, 1000);
        }

        // 页面可见时重新翻译（处理 SPA 路由）
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && state.enabled) {
                setTimeout(translatePage, 500);
            }
        });
    }

    // 启动
    init();
})();
