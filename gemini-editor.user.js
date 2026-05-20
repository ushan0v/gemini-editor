// ==UserScript==
// @name         Gemini Editor
// @namespace    https://github.com/ushan0v/gemini-editor
// @version      1.0.1
// @description  Unlocks editing for previous user messages in Gemini chats.
// @author       ushan0v
// @license      MIT
// @match        https://gemini.google.com/*
// @run-at       document-start
// @grant        none
// @icon         https://www.google.com/s2/favicons?sz=64&domain=gemini.google.com
// @homepageURL  https://github.com/ushan0v/gemini-editor
// @supportURL   https://github.com/ushan0v/gemini-editor/issues
// ==/UserScript==

(function () {
    'use strict';

    const DEBUG = false;
    const LOG_PREFIX = '[Gemini Editor]';
    const STYLE_ID = 'gemini-editor-userscript-style';
    const TOOLTIP_ID = 'gemini-editor-tooltip';
    const XHR_URL = Symbol('geminiEditorUrl');
    const XHR_CAPTURE_ATTACHED = Symbol('geminiEditorCaptureAttached');
    const XHR_STREAM_CAPTURE_LENGTH = Symbol('geminiEditorStreamCaptureLength');
    const ATTRS = {
        processed: 'data-gemini-editor-processed',
        wrapper: 'data-gemini-editor-wrapper',
        customButton: 'data-gemini-editor-button',
        optimistic: 'data-gemini-editor-optimistic',
        optimisticAttachments: 'data-gemini-editor-optimistic-attachments',
        attachmentOwned: 'data-gemini-editor-owned',
        attachmentKey: 'data-gemini-editor-attachment-key',
        tooltip: 'data-gemini-editor-tooltip',
    };
    const SELECTORS = {
        appMain: 'main',
        conversationContainer: '.conversation-container',
        userQuery: 'user-query',
        editor: '.ql-editor.textarea',
        textInputField: '.text-input-field',
        queryText: '.query-text',
        queryTextLine: '.query-text-line',
        hiddenText: '.cdk-visually-hidden, .screen-reader-user-query-label, [aria-hidden="true"], [hidden]',
        responseNodes: 'model-response, pending-response, dual-model-response, generative-ui-response',
        inputAreaContainer: '.input-area-container',
        attachmentPreviewWrapper: '.attachment-preview-wrapper',
        nativeAttachmentPreviewWrapper: '.attachment-preview-wrapper:not([data-gemini-editor-owned="true"])',
        ownedAttachmentPreviewWrapper: '.attachment-preview-wrapper[data-gemini-editor-owned="true"]',
        attachmentPreviewContainer: 'uploader-file-preview-container',
        ownedAttachmentPreviewContainer: 'uploader-file-preview-container[data-gemini-editor-owned="true"]',
        userQueryFileButton: '[data-test-id="uploaded-file"] button[aria-label], button.new-file-preview-file[aria-label]',
        userQueryImagePreview: 'img[data-test-id="uploaded-img"]',
        userQueryVideoPreview: 'img[data-test-id="video-thumbnail"]',
        editModeBar: '.gemini-edit-mode-bar',
        copyIcon: 'mat-icon[fonticon="content_copy"], mat-icon[fonticon="copy"], mat-icon[data-mat-icon-name="content_copy"], mat-icon[data-mat-icon-name="copy"]',
        nativeEditIcon: 'mat-icon[fonticon="edit"], mat-icon[data-mat-icon-name="edit"]',
        nativeEditButton: '[data-test-id="prompt-edit-button"], button[data-test-id="prompt-edit-button"]',
        nativePromptActionHost: '[data-test-id="prompt-edit-button"]:not([data-gemini-editor-wrapper="true"]):not([data-gemini-editor-button="true"])',
        sendButton: 'button.send-button.submit, gem-icon-button.send-button.submit',
        jslog: '[jslog]',
        draftNode: '[data-test-draft-id]',
    };
    const UI_STRINGS = {
        editLabel: 'Edit',
        editTooltip: 'Edit prompt',
        editMode: 'Editing mode',
        cancel: 'Cancel',
        removeFile: 'Remove file',
        imagePreview: 'Image preview',
        videoPreview: 'Video preview',
        openImagePreview: 'Open uploaded image preview',
        openVideoPreview: 'Open uploaded video preview',
        unknownType: 'Unknown',
    };

    const state = {
        editTargetContainer: null,
        editContextPath: null,
        pendingOverride: null,
        optimisticContainer: null,
        attachmentCache: new Map(),
        attachmentCarryover: null,
        cacheScopeConversationId: null,
        observer: null,
        scanQueued: false,
        uiStarted: false,
        tooltipTarget: null,
    };

    const CODE_FILE_EXTENSIONS = new Set([
        'astro', 'bash', 'bat', 'c', 'cc', 'cfg', 'conf', 'cpp', 'cs',
        'css', 'cts', 'cxx', 'go', 'graphql', 'h', 'hpp', 'htm', 'html',
        'ini', 'java', 'js', 'json', 'jsx', 'kt', 'kts', 'less', 'lua',
        'mjs', 'php', 'plist', 'properties', 'ps1',
        'py', 'rb', 'rs', 'sass', 'scss', 'sh', 'sql', 'svelte', 'svg',
        'swift', 'toml', 'ts', 'tsx', 'txt', 'vue', 'xml', 'yaml', 'yml',
        'zsh',
    ]);
    const PLAIN_TEXT_FILE_EXTENSIONS = new Set([
        'csv', 'log', 'md', 'markdown', 'rst', 'text', 'tsv', 'txt',
    ]);
    const ARCHIVE_FILE_EXTENSIONS = new Set([
        '7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'xz', 'zip',
    ]);

    function logDebug() {
        if (DEBUG) {
            console.debug(LOG_PREFIX, '[debug]', ...arguments);
        }
    }

    function getUiStrings() {
        return UI_STRINGS;
    }

    function getNativeIconTemplate(fonticon) {
        return document.querySelector(`mat-icon[fonticon="${fonticon}"]`)
            || document.querySelector(`mat-icon[data-mat-icon-name="${fonticon}"]`)
            || document.querySelector('mat-icon.lumi-symbols')
            || document.querySelector('mat-icon.google-symbols');
    }

    function getScopeAttributeName(node, prefix) {
        if (!node?.attributes) {
            return null;
        }

        for (const attribute of Array.from(node.attributes)) {
            if (attribute.name.startsWith(prefix)) {
                return attribute.name;
            }
        }

        return null;
    }

    function applyScopeAttribute(node, attributeName) {
        if (node && attributeName) {
            node.setAttribute(attributeName, '');
        }

        return node;
    }

    function getComposerScopeAttributes(textInputField) {
        const field = textInputField || getTextInputField();
        if (!field) {
            return {
                inputContentAttr: null,
                previewContainerHostAttr: null,
                previewChipContentAttr: null,
                previewChipHostAttr: null,
                previewInnerContentAttr: null,
                fileAttachmentContentAttr: null,
                fileAttachmentHostAttr: null,
                mediaAttachmentContentAttr: null,
                mediaAttachmentHostAttr: null,
                iconButtonHostAttr: null,
            };
        }

        const inputContentAttr = getScopeAttributeName(field, '_ngcontent-')
            || Array.from(field.children)
                .map((child) => getScopeAttributeName(child, '_ngcontent-'))
                .find(Boolean)
            || null;
        const nativeContainer = field.querySelector(`${SELECTORS.nativeAttachmentPreviewWrapper} ${SELECTORS.attachmentPreviewContainer}`);
        const nativeChip = nativeContainer?.querySelector('uploader-file-preview') || null;
        const nativeInner = nativeChip?.querySelector('.file-preview-container, .file-preview, .image-preview') || null;
        const nativeFileAttachment = nativeChip?.querySelector('gem-attachment') || field.querySelector('gem-attachment') || null;
        const nativeMediaAttachment = nativeChip?.querySelector('gem-media-attachment') || field.querySelector('gem-media-attachment') || null;
        const nativeCloseButtonHost = nativeChip?.querySelector('.gem-attachment-close-button') || field.querySelector('.gem-attachment-close-button') || null;

        return {
            inputContentAttr,
            previewContainerHostAttr: getScopeAttributeName(nativeContainer, '_nghost-'),
            previewChipContentAttr: getScopeAttributeName(nativeChip, '_ngcontent-'),
            previewChipHostAttr: getScopeAttributeName(nativeChip, '_nghost-'),
            previewInnerContentAttr: getScopeAttributeName(nativeInner, '_ngcontent-'),
            fileAttachmentContentAttr: getScopeAttributeName(nativeFileAttachment, '_ngcontent-'),
            fileAttachmentHostAttr: getScopeAttributeName(nativeFileAttachment, '_nghost-'),
            mediaAttachmentContentAttr: getScopeAttributeName(nativeMediaAttachment, '_ngcontent-'),
            mediaAttachmentHostAttr: getScopeAttributeName(nativeMediaAttachment, '_nghost-'),
            iconButtonHostAttr: getScopeAttributeName(nativeCloseButtonHost, '_nghost-'),
        };
    }

    function getOwnedTooltipElement() {
        let tooltip = document.getElementById(TOOLTIP_ID);
        if (tooltip) {
            return tooltip;
        }

        tooltip = document.createElement('div');
        tooltip.id = TOOLTIP_ID;
        tooltip.className = 'gemini-editor-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.setAttribute('aria-hidden', 'true');
        tooltip.hidden = true;

        const target = document.body || document.documentElement;
        target?.appendChild(tooltip);
        return tooltip;
    }

    function positionOwnedTooltip(target) {
        const tooltip = document.getElementById(TOOLTIP_ID);
        if (!tooltip || !target?.isConnected) {
            return;
        }

        const rect = target.getBoundingClientRect();
        if (!rect.width && !rect.height) {
            return;
        }

        const tooltipRect = tooltip.getBoundingClientRect();
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const preferredTop = rect.top - tooltipRect.height - 8;
        const fallbackTop = rect.bottom + 8;
        const top = preferredTop >= 8
            ? preferredTop
            : Math.min(fallbackTop, Math.max(8, window.innerHeight - tooltipRect.height - 8));
        const left = Math.min(
            Math.max(8, rect.left + (rect.width / 2) - (tooltipRect.width / 2)),
            Math.max(8, viewportWidth - tooltipRect.width - 8),
        );

        tooltip.style.left = `${Math.round(left)}px`;
        tooltip.style.top = `${Math.round(top)}px`;
    }

    function showOwnedTooltip(target) {
        const tooltipText = target?.getAttribute?.(ATTRS.tooltip);
        if (!tooltipText) {
            return;
        }

        const tooltip = getOwnedTooltipElement();
        state.tooltipTarget = target;
        tooltip.textContent = tooltipText;
        tooltip.hidden = false;
        tooltip.setAttribute('aria-hidden', 'false');
        tooltip.classList.add('visible');
        window.requestAnimationFrame(() => {
            if (state.tooltipTarget === target) {
                positionOwnedTooltip(target);
            }
        });
    }

    function hideOwnedTooltip() {
        state.tooltipTarget = null;
        const tooltip = document.getElementById(TOOLTIP_ID);
        if (!tooltip) {
            return;
        }

        tooltip.classList.remove('visible');
        tooltip.setAttribute('aria-hidden', 'true');
        window.setTimeout(() => {
            if (!tooltip.classList.contains('visible')) {
                tooltip.hidden = true;
            }
        }, 120);
    }

    function syncOwnedTooltipPosition() {
        if (state.tooltipTarget?.isConnected) {
            positionOwnedTooltip(state.tooltipTarget);
            return;
        }

        hideOwnedTooltip();
    }

    function initTooltipController() {
        if (document.documentElement?.dataset?.geminiEditorTooltipReady === 'true') {
            return;
        }

        document.documentElement.dataset.geminiEditorTooltipReady = 'true';

        document.addEventListener('pointerover', (event) => {
            const target = event.target?.closest?.(`[${ATTRS.tooltip}]`);
            if (!target || target === state.tooltipTarget) {
                return;
            }

            showOwnedTooltip(target);
        }, true);

        document.addEventListener('pointerout', (event) => {
            if (!state.tooltipTarget) {
                return;
            }

            const currentTarget = event.target?.closest?.(`[${ATTRS.tooltip}]`);
            const relatedTarget = event.relatedTarget?.closest?.(`[${ATTRS.tooltip}]`) || null;
            if (currentTarget === state.tooltipTarget && relatedTarget !== state.tooltipTarget) {
                hideOwnedTooltip();
            }
        }, true);

        document.addEventListener('focusin', (event) => {
            const target = event.target?.closest?.(`[${ATTRS.tooltip}]`);
            if (target) {
                showOwnedTooltip(target);
            }
        }, true);

        document.addEventListener('focusout', (event) => {
            if (event.target?.closest?.(`[${ATTRS.tooltip}]`) === state.tooltipTarget) {
                hideOwnedTooltip();
            }
        }, true);

        window.addEventListener('scroll', syncOwnedTooltipPosition, true);
        window.addEventListener('resize', syncOwnedTooltipPosition);
    }

    function ensureButtonRippleSpan(button) {
        if (!button || button.querySelector(':scope > .mat-ripple.mat-mdc-button-ripple')) {
            return;
        }

        const ripple = document.createElement('span');
        ripple.className = 'mat-ripple mat-mdc-button-ripple';
        button.appendChild(ripple);
    }

    function ensureComposerButtonRipples(root = document) {
        root.querySelectorAll([
            'button[data-test-id="bard-mode-menu-button"]',
            'button.speech_dictation_mic_button',
            'button.send-button.submit',
            'gem-icon-button.speech_dictation_mic_button button',
            'gem-icon-button.send-button.submit button',
            `button[${ATTRS.customButton}="true"]`,
        ].join(', ')).forEach(ensureButtonRippleSpan);
    }

    function logDebugIssue() {
        if (DEBUG) {
            console.debug(LOG_PREFIX, '[debug:issue]', ...arguments);
        }
    }

    function decodeHtmlAttributeValue(rawValue) {
        if (typeof rawValue !== 'string') {
            return '';
        }

        return rawValue
            .replace(/&quot;/g, '"')
            .replace(/&#34;/g, '"')
            .replace(/&amp;/g, '&');
    }

    function extractBalancedBracketSegment(source, marker) {
        if (typeof source !== 'string' || typeof marker !== 'string') {
            return null;
        }

        const markerIndex = source.indexOf(marker);
        if (markerIndex === -1) {
            return null;
        }

        const startIndex = source.indexOf('[', markerIndex + marker.length);
        if (startIndex === -1) {
            return null;
        }

        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let index = startIndex; index < source.length; index += 1) {
            const char = source[index];

            if (escaped) {
                escaped = false;
                continue;
            }

            if (char === '\\') {
                escaped = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (inString) {
                continue;
            }

            if (char === '[') {
                depth += 1;
                continue;
            }

            if (char === ']') {
                depth -= 1;
                if (depth === 0) {
                    return source.slice(startIndex, index + 1);
                }
            }
        }

        return null;
    }

    function normalizeJslogMetadata(parsedMetadata) {
        if (!parsedMetadata) {
            return null;
        }

        const data = Array.isArray(parsedMetadata[0]) ? parsedMetadata[0] : parsedMetadata;
        if (!Array.isArray(data)) {
            return null;
        }

        const result = {
            r: typeof data[0] === 'string' && data[0].startsWith('r_') ? data[0] : null,
            c: typeof data[1] === 'string' && data[1].startsWith('c_') ? data[1] : null,
            rc: typeof data[3] === 'string' && data[3].startsWith('rc_') ? data[3] : null,
        };

        return result.r || result.c || result.rc ? result : null;
    }

    function extractDataFromJslog(rawJslog) {
        if (!rawJslog) {
            return null;
        }

        const decoded = decodeHtmlAttributeValue(rawJslog);
        const metadataJson = extractBalancedBracketSegment(decoded, 'BardVeMetadataKey:');
        if (!metadataJson) {
            return null;
        }

        try {
            return normalizeJslogMetadata(JSON.parse(metadataJson));
        } catch (error) {
            logDebugIssue('Failed to parse jslog metadata.', error);
            return null;
        }
    }

    function getJslogDataScore(data) {
        if (!data) {
            return -1;
        }

        return (data.r ? 4 : 0) + (data.c ? 2 : 0) + (data.rc ? 1 : 0);
    }

    function mergeJslogData(base, next) {
        if (!base) {
            return next || null;
        }

        if (!next) {
            return base;
        }

        return {
            r: base.r || next.r || null,
            c: base.c || next.c || null,
            rc: base.rc || next.rc || null,
        };
    }

    function getBestJslogData(root) {
        if (!root) {
            return null;
        }

        const nodes = [];
        if (root instanceof Element && root.hasAttribute('jslog')) {
            nodes.push(root);
        }

        if (root.querySelectorAll) {
            nodes.push(...root.querySelectorAll(SELECTORS.jslog));
        }

        let best = null;
        let bestScore = -1;

        nodes.forEach((node) => {
            const next = extractDataFromJslog(node.getAttribute('jslog'));
            if (!next) {
                return;
            }

            const merged = mergeJslogData(best, next);
            const score = getJslogDataScore(merged);
            if (score > bestScore) {
                best = merged;
                bestScore = score;
            }
        });

        return best;
    }

    function getAttachmentCacheKey(conversationId, messageId) {
        if (!conversationId || !messageId) {
            return null;
        }

        return `${conversationId}::${messageId}`;
    }

    function parseBatchExecuteEntries(rawText) {
        if (typeof rawText !== 'string' || !rawText.length) {
            return [];
        }

        const normalized = rawText.replace(/^\)\]\}'\r?\n+/, '');
        const lines = normalized.split('\n');
        const entries = [];

        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (!line) {
                continue;
            }

            const candidate = /^\d+$/.test(line) ? lines[index + 1] : line;
            if (candidate === undefined) {
                continue;
            }

            try {
                const parsed = JSON.parse(candidate);
                if (Array.isArray(parsed) && parsed.length === 1 && Array.isArray(parsed[0])) {
                    entries.push(parsed[0]);
                } else {
                    entries.push(parsed);
                }

                if (/^\d+$/.test(line)) {
                    index += 1;
                }
            } catch {
                continue;
            }
        }

        return entries;
    }

    function getBatchExecutePayload(rawText, rpcid) {
        const entry = parseBatchExecuteEntries(rawText).find((item) => {
            return Array.isArray(item) && item[0] === 'wrb.fr' && item[1] === rpcid && typeof item[2] === 'string';
        });

        if (!entry) {
            return null;
        }

        try {
            return JSON.parse(entry[2]);
        } catch (error) {
            logDebugIssue('Failed to parse batchexecute payload.', error);
            return null;
        }
    }

    function getStreamGeneratePayloads(rawText) {
        return parseBatchExecuteEntries(rawText)
            .filter((item) => {
                return Array.isArray(item) && item[0] === 'wrb.fr' && typeof item[2] === 'string';
            })
            .map((item) => {
                try {
                    return JSON.parse(item[2]);
                } catch (error) {
                    logDebugIssue('Failed to parse StreamGenerate payload.', error);
                    return null;
                }
            })
            .filter(Boolean);
    }

    function isConversationId(value) {
        return typeof value === 'string' && value.startsWith('c_');
    }

    function isMessageId(value) {
        return typeof value === 'string' && value.startsWith('r_');
    }

    function getStreamPayloadIds(payload) {
        const ids = Array.isArray(payload?.[1]) ? payload[1] : [];
        const conversationId = isConversationId(ids[0])
            ? ids[0]
            : getConversationIdFromLocation();
        const messageId = isMessageId(ids[1])
            ? ids[1]
            : (isMessageId(ids[0]) ? ids[0] : null);

        return { conversationId, messageId };
    }

    function isRawAttachmentEntry(value) {
        return Array.isArray(value)
            && typeof value[2] === 'string'
            && typeof value[5] === 'string'
            && typeof value[11] === 'string';
    }

    function collectTurnLikeNodes(root, out = []) {
        if (!Array.isArray(root)) {
            return out;
        }

        const turnKey = root[0];
        if (Array.isArray(turnKey) && isConversationId(turnKey[0]) && isMessageId(turnKey[1])) {
            out.push(root);
        }

        root.forEach((item) => {
            if (Array.isArray(item)) {
                collectTurnLikeNodes(item, out);
            }
        });

        return out;
    }

    function collectAttachmentArrays(root, out = []) {
        if (Array.isArray(root)) {
            if (root.length > 0 && root.every(isRawAttachmentEntry)) {
                out.push(root);
                return out;
            }

            root.forEach((item) => {
                collectAttachmentArrays(item, out);
            });
            return out;
        }

        if (root && typeof root === 'object') {
            Object.values(root).forEach((item) => {
                collectAttachmentArrays(item, out);
            });
            return out;
        }

        return out;
    }

    function dedupeAttachmentsByToken(attachments) {
        const seen = new Set();
        return attachments.filter((attachment) => {
            if (!attachment?.token || seen.has(attachment.token)) {
                return false;
            }

            seen.add(attachment.token);
            return true;
        });
    }

    function isAttachmentArray(value) {
        return Array.isArray(value) && value.length > 0 && value.every(isRawAttachmentEntry);
    }

    function extractRawAttachmentsFromUserMessage(userMessage) {
        if (!Array.isArray(userMessage)) {
            return [];
        }

        const directCandidates = [
            userMessage?.[4]?.[0]?.[3],
            userMessage?.[4]?.[1],
            userMessage?.[5]?.[0]?.[3],
        ];

        for (const candidate of directCandidates) {
            if (isAttachmentArray(candidate)) {
                return candidate;
            }
        }

        const attachmentArrays = collectAttachmentArrays(userMessage[4] ?? [], []);
        return attachmentArrays.sort((left, right) => right.length - left.length)[0] || [];
    }

    function extractRawAttachmentsFromTurn(turn) {
        if (!Array.isArray(turn)) {
            return [];
        }

        const directUserMessage = Array.isArray(turn?.[2]?.[0])
            ? turn[2][0]
            : null;
        const directAttachments = extractRawAttachmentsFromUserMessage(directUserMessage);
        if (directAttachments.length) {
            return directAttachments;
        }

        const nestedUserMessage = Array.isArray(turn?.[2])
            ? turn[2].find((item) => {
                return Array.isArray(item) && extractRawAttachmentsFromUserMessage(item).length > 0;
            })
            : null;

        return extractRawAttachmentsFromUserMessage(nestedUserMessage);
    }

    function setAttachmentCarryover(conversationId, attachments, meta = {}) {
        const nextAttachments = Array.isArray(attachments)
            ? attachments.map(cloneAttachmentRecord).filter(Boolean)
            : [];

        state.attachmentCarryover = nextAttachments.length
            ? {
                conversationId,
                attachments: nextAttachments,
                createdAt: Date.now(),
                submittedText: normalizePromptText(meta.submittedText ?? ''),
                targetIndex: Number.isInteger(meta.targetIndex) ? meta.targetIndex : null,
            }
            : null;
    }

    function getAttachmentCarryover() {
        if (!state.attachmentCarryover) {
            return null;
        }

        if ((Date.now() - state.attachmentCarryover.createdAt) > 120000) {
            state.attachmentCarryover = null;
            return null;
        }

        return state.attachmentCarryover;
    }

    function promoteAttachmentCarryoverToContainer(container, index) {
        const carryover = getAttachmentCarryover();
        if (!carryover || !container) {
            return false;
        }

        const userQuery = container.querySelector(SELECTORS.userQuery);
        const currentData = mergeJslogData(
            getBestJslogData(userQuery),
            getBestJslogData(container),
        );
        const conversationId = currentData?.c || getConversationIdFromLocation();
        const cacheKey = getAttachmentCacheKey(conversationId, currentData?.r);
        if (!cacheKey || !currentData?.r || (carryover.conversationId && carryover.conversationId !== conversationId)) {
            return false;
        }

        if (Number.isInteger(carryover.targetIndex) && Number.isInteger(index) && index < carryover.targetIndex) {
            return false;
        }

        if (carryover.submittedText) {
            const queryText = getPlainTextFromElement(userQuery?.querySelector(SELECTORS.queryText));
            if (normalizePromptText(queryText) !== carryover.submittedText) {
                return false;
            }
        }

        const existing = state.attachmentCache.get(cacheKey);
        if (Array.isArray(existing) && existing.length) {
            state.attachmentCarryover = null;
            return false;
        }

        state.attachmentCache.set(cacheKey, carryover.attachments.map(cloneAttachmentRecord).filter(Boolean));
        state.attachmentCarryover = null;
        logDebug('Promoted carryover attachments to refreshed message.', {
            conversationId,
            messageId: currentData.r,
            count: state.attachmentCache.get(cacheKey)?.length ?? 0,
        });
        return true;
    }

    function getAttachmentCarryoverForContainer(container, index) {
        const carryover = getAttachmentCarryover();
        if (!carryover || !container) {
            return [];
        }

        const userQuery = container.querySelector(SELECTORS.userQuery);
        const currentData = mergeJslogData(
            getBestJslogData(userQuery),
            getBestJslogData(container),
        );
        const conversationId = currentData?.c || getConversationIdFromLocation();
        if (carryover.conversationId && conversationId && carryover.conversationId !== conversationId) {
            return [];
        }

        if (Number.isInteger(carryover.targetIndex) && Number.isInteger(index) && index < carryover.targetIndex) {
            return [];
        }

        if (carryover.submittedText) {
            const queryText = getPlainTextFromElement(userQuery?.querySelector(SELECTORS.queryText));
            if (normalizePromptText(queryText) !== carryover.submittedText) {
                return [];
            }
        }

        return carryover.attachments.map(cloneAttachmentRecord).filter(Boolean);
    }

    function cloneAttachmentRecord(attachment) {
        if (!attachment) {
            return null;
        }

        return {
            key: attachment.key,
            kind: attachment.kind,
            typeCode: attachment.typeCode,
            filename: attachment.filename,
            displayName: attachment.displayName,
            typeLabel: attachment.typeLabel,
            mime: attachment.mime,
            token: attachment.token,
            previewUrl: attachment.previewUrl,
            downloadUrl: attachment.downloadUrl,
            viewUrl: attachment.viewUrl,
            width: attachment.width,
            height: attachment.height,
            durationSeconds: attachment.durationSeconds,
            payloadRecord: cloneAttachmentPayloadRecord(attachment.payloadRecord),
        };
    }

    function getAttachmentFileExtension(filename) {
        if (typeof filename !== 'string') {
            return '';
        }

        const match = filename.match(/\.([^.]+)$/);
        return match ? match[1].toLowerCase() : '';
    }

    function stripAttachmentExtension(filename) {
        if (typeof filename !== 'string') {
            return '';
        }

        return filename.replace(/\.[^.]+$/, '');
    }

    function truncateMiddle(value, maxLength) {
        if (typeof value !== 'string' || value.length <= maxLength) {
            return value ?? '';
        }

        const edgeLength = Math.max(4, Math.floor((maxLength - 3) / 2));
        return `${value.slice(0, edgeLength)}...${value.slice(-edgeLength)}`;
    }

    function getAttachmentMimeSubtype(mime) {
        if (typeof mime !== 'string' || !mime.includes('/')) {
            return '';
        }

        return mime.split('/')[1]?.split(';')[0]?.trim().toLowerCase() || '';
    }

    function isPlainTextAttachment(attachment) {
        const extension = getAttachmentFileExtension(attachment?.filename);
        const mime = typeof attachment?.mime === 'string' ? attachment.mime.toLowerCase() : '';
        return mime === 'text/plain' || PLAIN_TEXT_FILE_EXTENSIONS.has(extension);
    }

    function isArchiveAttachment(attachment) {
        const extension = getAttachmentFileExtension(attachment?.filename);
        const mime = typeof attachment?.mime === 'string' ? attachment.mime.toLowerCase() : '';
        return ARCHIVE_FILE_EXTENSIONS.has(extension)
            || mime === 'application/zip'
            || mime === 'application/x-zip-compressed'
            || mime === 'application/x-7z-compressed'
            || mime === 'application/x-rar-compressed'
            || mime === 'application/gzip'
            || mime === 'application/x-tar';
    }

    function formatAttachmentTypeLabel(attachment) {
        const strings = getUiStrings();
        const extension = getAttachmentFileExtension(attachment?.filename);

        if (attachment?.kind === 'image') {
            return extension ? extension.toUpperCase() : 'IMG';
        }

        if (attachment?.kind === 'video') {
            return extension ? extension.toUpperCase() : 'VIDEO';
        }

        if (isCodeLikeAttachment(attachment) || isPlainTextAttachment(attachment) || isArchiveAttachment(attachment)) {
            return extension ? extension.toUpperCase() : (getAttachmentMimeSubtype(attachment?.mime) || strings.unknownType).toUpperCase();
        }

        if (attachment?.mime === 'application/octet-stream') {
            return strings.unknownType;
        }

        if (extension && extension.length <= 8) {
            return extension.toUpperCase();
        }

        const mimeSubtype = getAttachmentMimeSubtype(attachment?.mime);
        if (mimeSubtype && mimeSubtype.length <= 8) {
            return mimeSubtype.toUpperCase();
        }

        return strings.unknownType;
    }

    function formatAttachmentDisplayName(attachment) {
        if (!attachment?.filename) {
            return '';
        }

        if (attachment.kind === 'image' || attachment.kind === 'video') {
            return attachment.filename;
        }

        const isUnknownBinary = attachment.mime === 'application/octet-stream'
            && !isCodeLikeAttachment(attachment)
            && !isPlainTextAttachment(attachment)
            && !isArchiveAttachment(attachment);
        const baseName = isUnknownBinary
            ? attachment.filename
            : (stripAttachmentExtension(attachment.filename) || attachment.filename);

        return truncateMiddle(baseName, isUnknownBinary ? 23 : 22);
    }

    function getAttachmentKind(rawAttachment) {
        const mime = rawAttachment?.[11] ?? '';
        const typeCode = Number(rawAttachment?.[1]);

        if (typeCode === 1 || mime.startsWith('image/')) {
            return 'image';
        }

        if (typeCode === 2 || mime.startsWith('video/')) {
            return 'video';
        }

        return 'file';
    }

    function getAttachmentPreviewUrl(rawAttachment, kind) {
        if (kind === 'image' && typeof rawAttachment?.[3] === 'string' && rawAttachment[3]) {
            return rawAttachment[3];
        }

        const urlGroup = Array.isArray(rawAttachment?.[7]) ? rawAttachment[7] : [];
        return typeof urlGroup[0] === 'string' && urlGroup[0] ? urlGroup[0] : null;
    }

    function getAttachmentViewUrl(rawAttachment, kind) {
        const urlGroup = Array.isArray(rawAttachment?.[7]) ? rawAttachment[7] : [];

        if (kind === 'video' && typeof urlGroup[2] === 'string' && urlGroup[2]) {
            return urlGroup[2];
        }

        if (typeof rawAttachment?.[3] === 'string' && rawAttachment[3]) {
            return rawAttachment[3];
        }

        return typeof urlGroup[0] === 'string' && urlGroup[0] ? urlGroup[0] : null;
    }

    function getAttachmentDimensions(rawAttachment, kind) {
        if (kind === 'video' && Array.isArray(rawAttachment?.[16])) {
            return {
                width: Number(rawAttachment[16][2]) || null,
                height: Number(rawAttachment[16][1]) || null,
            };
        }

        if (Array.isArray(rawAttachment?.[15])) {
            return {
                width: Number(rawAttachment[15][0]) || null,
                height: Number(rawAttachment[15][1]) || null,
            };
        }

        return { width: null, height: null };
    }

    function getAttachmentDurationSeconds(rawAttachment) {
        const durationParts = rawAttachment?.[16]?.[0];
        if (!Array.isArray(durationParts)) {
            return null;
        }

        const seconds = Number(durationParts[0]);
        const nanos = Number(durationParts[1]);

        if (!Number.isFinite(seconds)) {
            return null;
        }

        if (!Number.isFinite(nanos)) {
            return seconds;
        }

        return Math.max(0, Math.round(seconds + (nanos / 1000000000)));
    }

    function normalizeConversationAttachment(rawAttachment) {
        if (!Array.isArray(rawAttachment)) {
            return null;
        }

        const kind = getAttachmentKind(rawAttachment);
        const filename = typeof rawAttachment[2] === 'string' ? rawAttachment[2] : '';
        const mime = typeof rawAttachment[11] === 'string' ? rawAttachment[11] : '';
        const token = typeof rawAttachment[5] === 'string' ? rawAttachment[5] : '';

        if (!filename || !mime || !token) {
            return null;
        }

        const { width, height } = getAttachmentDimensions(rawAttachment, kind);
        const attachment = {
            key: token || `${filename}:${mime}`,
            kind,
            typeCode: Number(rawAttachment[1]) || 0,
            filename,
            mime,
            token,
            previewUrl: getAttachmentPreviewUrl(rawAttachment, kind),
            downloadUrl: typeof rawAttachment?.[7]?.[1] === 'string' && rawAttachment[7][1] ? rawAttachment[7][1] : null,
            viewUrl: getAttachmentViewUrl(rawAttachment, kind),
            width,
            height,
            durationSeconds: getAttachmentDurationSeconds(rawAttachment),
        };

        attachment.typeLabel = formatAttachmentTypeLabel(attachment);
        attachment.displayName = formatAttachmentDisplayName(attachment);

        return attachment;
    }

    function cloneAttachmentPayloadRecord(payloadRecord) {
        if (!Array.isArray(payloadRecord)) {
            return null;
        }

        return payloadRecord.map((item) => {
            return Array.isArray(item) ? cloneAttachmentPayloadRecord(item) : item;
        });
    }

    function normalizePayloadAttachmentRecord(payloadRecord, uiAttachment = {}) {
        if (!Array.isArray(payloadRecord) || !Array.isArray(payloadRecord[0])) {
            return null;
        }

        const typeCode = Number(payloadRecord[0][1]) || 0;
        const filename = typeof payloadRecord[1] === 'string' ? payloadRecord[1] : '';
        const mime = typeof payloadRecord[0][3] === 'string' ? payloadRecord[0][3] : '';
        const token = typeof payloadRecord[2] === 'string' ? payloadRecord[2] : '';
        if (!filename || !mime) {
            return null;
        }

        const kind = typeCode === 1 || mime.startsWith('image/')
            ? 'image'
            : (typeCode === 2 || mime.startsWith('video/') ? 'video' : 'file');
        const attachment = {
            key: token || `${filename}:${mime}:${payloadRecord[0][0] || ''}`,
            kind,
            typeCode,
            filename,
            mime,
            token,
            previewUrl: uiAttachment.previewUrl || null,
            downloadUrl: null,
            viewUrl: uiAttachment.viewUrl || uiAttachment.previewUrl || null,
            width: null,
            height: null,
            durationSeconds: uiAttachment.durationSeconds ?? null,
            payloadRecord: cloneAttachmentPayloadRecord(payloadRecord),
        };

        attachment.typeLabel = formatAttachmentTypeLabel(attachment);
        attachment.displayName = formatAttachmentDisplayName(attachment);

        return attachment;
    }

    function buildAttachmentPayloadRecord(attachment) {
        const payloadRecord = cloneAttachmentPayloadRecord(attachment?.payloadRecord);
        if (payloadRecord) {
            return payloadRecord;
        }

        if (!attachment?.filename || !attachment?.mime || !attachment?.token) {
            return null;
        }

        return [
            [null, attachment.typeCode, 1, attachment.mime],
            attachment.filename,
            attachment.token,
        ];
    }

    function getCachedAttachmentsForMessage(conversationId, messageId) {
        const cacheKey = getAttachmentCacheKey(conversationId, messageId);
        const attachments = cacheKey ? state.attachmentCache.get(cacheKey) : null;
        return Array.isArray(attachments)
            ? attachments.map(cloneAttachmentRecord).filter(Boolean)
            : [];
    }

    function storeConversationLoadPayload(payload) {
        const turns = collectTurnLikeNodes(payload);
        const activeConversationId = getConversationIdFromLocation();

        turns.forEach((turn) => {
            const turnKey = Array.isArray(turn?.[0]) ? turn[0] : null;
            const conversationId = turnKey?.[0] ?? null;
            const messageId = turnKey?.[1] ?? null;
            if (activeConversationId && conversationId && conversationId !== activeConversationId) {
                return;
            }

            const cacheKey = getAttachmentCacheKey(conversationId, messageId);
            if (!cacheKey) {
                return;
            }

            const rawAttachmentArray = extractRawAttachmentsFromTurn(turn);
            const attachments = dedupeAttachmentsByToken(
                rawAttachmentArray
                    .map(normalizeConversationAttachment)
                    .filter(Boolean),
            );

            state.attachmentCache.set(cacheKey, attachments);
            logDebug('Stored attachments from conversation-load.', {
                conversationId,
                messageId,
                count: attachments.length,
            });
        });
    }

    function getAttachmentsFromPayload(payload) {
        const rawAttachments = [];
        collectAttachmentArrays(payload).forEach((attachmentArray) => {
            rawAttachments.push(...attachmentArray);
        });

        return dedupeAttachmentsByToken(
            rawAttachments
                .map(normalizeConversationAttachment)
                .filter(Boolean),
        );
    }

    function haveSameAttachmentTokens(left, right) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }

        return left.every((attachment, index) => {
            return attachment?.token && attachment.token === right[index]?.token;
        });
    }

    function storeStreamGeneratePayload(payload) {
        const { conversationId, messageId } = getStreamPayloadIds(payload);
        const cacheKey = getAttachmentCacheKey(conversationId, messageId);
        if (!cacheKey) {
            return false;
        }

        const attachments = getAttachmentsFromPayload(payload);
        if (!attachments.length) {
            return false;
        }

        const existing = state.attachmentCache.get(cacheKey);
        if (haveSameAttachmentTokens(existing, attachments)) {
            return false;
        }

        state.attachmentCache.set(cacheKey, attachments);
        logDebug('Stored attachments from StreamGenerate.', {
            conversationId,
            messageId,
            count: attachments.length,
        });
        refreshPendingOverrideAttachments(conversationId, messageId, attachments);
        return true;
    }

    function refreshPendingOverrideAttachments(conversationId, messageId, attachments) {
        if (!state.pendingOverride?.attachments?.length || !state.editTargetContainer || !messageId) {
            return;
        }

        const userQuery = state.editTargetContainer.querySelector(SELECTORS.userQuery);
        const currentData = mergeJslogData(
            getBestJslogData(userQuery),
            getBestJslogData(state.editTargetContainer),
        );
        const targetConversationId = currentData?.c || getConversationIdFromLocation();
        if (currentData?.r !== messageId || (conversationId && targetConversationId && conversationId !== targetConversationId)) {
            return;
        }

        const usedAttachmentIndexes = new Set();
        const nextAttachments = state.pendingOverride.attachments.map((pendingAttachment) => {
            const replacementIndex = attachments.findIndex((attachment, index) => {
                return !usedAttachmentIndexes.has(index)
                    && attachment?.filename === pendingAttachment?.filename
                    && attachment?.kind === pendingAttachment?.kind;
            });
            if (replacementIndex === -1) {
                return pendingAttachment;
            }

            usedAttachmentIndexes.add(replacementIndex);
            return attachments[replacementIndex];
        });

        const upgraded = nextAttachments.some((attachment, index) => {
            return attachment?.token && attachment.token !== state.pendingOverride.attachments[index]?.token;
        });
        if (!upgraded) {
            return;
        }

        state.pendingOverride.attachments = nextAttachments.map(cloneAttachmentRecord).filter(Boolean);
        syncEditComposerAttachmentUi();
        logDebug('Refreshed pending edit attachments from StreamGenerate tokens.', {
            conversationId,
            messageId,
            count: state.pendingOverride.attachments.length,
        });
    }

    function handleConversationLoadResponse(rawText) {
        const payload = getBatchExecutePayload(rawText, 'hNvQHb');
        if (!payload) {
            return false;
        }

        storeConversationLoadPayload(payload);
        return true;
    }

    function handleStreamGenerateResponse(rawText) {
        return getStreamGeneratePayloads(rawText).reduce((storedAny, payload) => {
            return storeStreamGeneratePayload(payload) || storedAny;
        }, false);
    }

    function getAppMain() {
        return document.querySelector(SELECTORS.appMain) || document.body;
    }

    function getEditor() {
        return document.querySelector(SELECTORS.editor);
    }

    function getConversationContainers() {
        return Array.from(document.querySelectorAll(SELECTORS.conversationContainer));
    }

    function normalizeRenderedLineBreaks(value) {
        return typeof value === 'string' ? value.replace(/\r\n/g, '\n').replace(/\n$/, '') : '';
    }

    function normalizePromptText(text) {
        return typeof text === 'string' ? text.replace(/\r\n/g, '\n') : '';
    }

    function getNormalizedPromptLines(text) {
        const lines = normalizePromptText(text ?? '').split('\n');
        return lines.length ? lines : [''];
    }

    function populatePromptLineNode(lineNode, text) {
        lineNode.replaceChildren();

        if (text.length) {
            lineNode.textContent = text;
        } else {
            lineNode.appendChild(document.createElement('br'));
        }

        return lineNode;
    }

    function buildPromptLineNodes(text, createLineNode) {
        return getNormalizedPromptLines(text).map((line) => {
            return populatePromptLineNode(createLineNode(), line);
        });
    }

    function getPromptTextFromQueryElement(element) {
        if (!element) {
            return '';
        }

        const lineNodes = Array.from(element.querySelectorAll(SELECTORS.queryTextLine));
        if (!lineNodes.length) {
            return '';
        }

        return lineNodes
            .map((lineNode) => normalizeRenderedLineBreaks(lineNode.innerText))
            .join('\n');
    }

    function getPromptTextFromEditor(editor) {
        if (!editor) {
            return '';
        }

        const blocks = Array.from(editor.children);
        if (!blocks.length) {
            return normalizeRenderedLineBreaks(editor.innerText);
        }

        return blocks
            .map((block) => normalizeRenderedLineBreaks(block.innerText))
            .join('\n');
    }

    function getPlainTextFromElement(element) {
        if (!element) {
            return '';
        }

        if (element.matches?.(SELECTORS.queryText)) {
            return getPromptTextFromQueryElement(element);
        }

        if (element.matches?.(SELECTORS.editor)) {
            return getPromptTextFromEditor(element);
        }

        const blockTags = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
        const parts = [];

        function walk(node) {
            node.childNodes.forEach((child) => {
                if (child.nodeType === Node.TEXT_NODE) {
                    parts.push(child.nodeValue ?? '');
                    return;
                }

                if (child.nodeType !== Node.ELEMENT_NODE) {
                    return;
                }

                if (child.matches(SELECTORS.hiddenText)) {
                    return;
                }

                if (child.tagName === 'BR') {
                    parts.push('\n');
                }

                walk(child);

                if (blockTags.has(child.tagName)) {
                    parts.push('\n');
                }
            });
        }

        walk(element);

        let normalized = parts
            .join('')
            .replace(/\r\n/g, '\n');

        if (normalized.endsWith('\n')) {
            normalized = normalized.slice(0, -1);
        }

        return normalized;
    }

    function buildQuillParagraphs(text) {
        return buildPromptLineNodes(text, () => document.createElement('p'));
    }

    function setEditorContent(editor, text) {
        const fragment = document.createDocumentFragment();
        buildQuillParagraphs(text).forEach((node) => fragment.appendChild(node));
        editor.replaceChildren(fragment);
    }

    function getCurrentChatLocationKey() {
        return `${window.location.pathname}${window.location.search}`;
    }

    function getConversationIdFromLocation() {
        const match = window.location.pathname.match(/\/app\/([^/?#]+)/);
        if (!match || !match[1]) {
            return null;
        }

        return match[1].startsWith('c_') ? match[1] : `c_${match[1]}`;
    }

    function syncAttachmentCacheScope() {
        const conversationId = getConversationIdFromLocation();
        if (state.cacheScopeConversationId === conversationId) {
            return;
        }

        if (state.cacheScopeConversationId === null) {
            state.cacheScopeConversationId = conversationId;
            return;
        }

        state.cacheScopeConversationId = conversationId;
        state.attachmentCarryover = null;
        logDebug('Updated active chat scope.', {
            conversationId,
        });
    }

    function getEditorText() {
        const editor = getEditor();
        return editor ? getPlainTextFromElement(editor) : '';
    }

    function getTextInputField() {
        return document.querySelector(SELECTORS.textInputField);
    }

    function isCodeLikeAttachment(attachment) {
        const extension = getAttachmentFileExtension(attachment?.filename);
        if (attachment?.typeCode === 16 || CODE_FILE_EXTENSIONS.has(extension)) {
            return true;
        }

        const mime = typeof attachment?.mime === 'string' ? attachment.mime.toLowerCase() : '';
        return (mime.startsWith('text/')
            && mime !== 'text/plain')
            || mime === 'application/json'
            || mime === 'application/javascript'
            || mime === 'application/x-javascript'
            || mime === 'text/javascript'
            || mime === 'application/xml'
            || mime === 'text/xml'
            || mime === 'application/x-yaml';
    }

    function getAttachmentIconType(attachment) {
        if (isCodeLikeAttachment(attachment)) {
            return 'text/code';
        }

        if (isPlainTextAttachment(attachment)) {
            return 'text/plain';
        }

        if (isArchiveAttachment(attachment)) {
            return getAttachmentFileExtension(attachment?.filename) === 'zip'
                ? 'application/zip'
                : 'application/octet-stream';
        }

        const mime = typeof attachment?.mime === 'string' ? attachment.mime.toLowerCase() : '';
        return mime || 'application/octet-stream';
    }

    function getAttachmentIconUrl(attachment) {
        return `https://drive-thirdparty.googleusercontent.com/32/type/${getAttachmentIconType(attachment)}`;
    }

    function getAttachmentIconAltText(attachment) {
        const strings = getUiStrings();
        return `${attachment?.typeLabel || strings.unknownType} file icon`;
    }

    function formatAttachmentDuration(durationSeconds) {
        if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
            return '';
        }

        const hours = Math.floor(durationSeconds / 3600);
        const minutes = Math.floor((durationSeconds % 3600) / 60);
        const seconds = Math.floor(durationSeconds % 60);

        if (hours > 0) {
            return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }

        return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    function createMaterialIcon(name) {
        const template = getNativeIconTemplate(name);
        if (template) {
            const icon = template.cloneNode(true);
            icon.removeAttribute('id');
            icon.removeAttribute('aria-hidden');
            icon.setAttribute('aria-hidden', 'true');
            icon.setAttribute('fonticon', name);
            icon.setAttribute('data-mat-icon-name', name);
            if (name === 'play_arrow') {
                icon.classList.add('icon-filled');
            } else {
                icon.classList.remove('icon-filled');
            }
            return icon;
        }

        const icon = document.createElement('mat-icon');
        icon.setAttribute('role', 'img');
        icon.setAttribute('fonticon', name);
        icon.setAttribute('aria-hidden', 'true');
        icon.setAttribute('data-mat-icon-type', 'font');
        icon.setAttribute('data-mat-icon-name', name);
        icon.className = 'mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color';
        if (name === 'play_arrow') {
            icon.classList.add('icon-filled');
        }
        icon.textContent = name;
        return icon;
    }

    function getComposerNativeRemoveButtons(textInputField) {
        const field = textInputField || getTextInputField();
        if (!field) {
            return [];
        }

        return Array.from(field.querySelectorAll([
            `uploader-file-preview:not([${ATTRS.attachmentOwned}="true"]) button[data-test-id="cancel-button"]`,
            `uploader-file-preview:not([${ATTRS.attachmentOwned}="true"]) .gem-attachment-close-button button`,
        ].join(', ')));
    }

    function clearNativeComposerAttachments(textInputField) {
        const removeButtons = getComposerNativeRemoveButtons(textInputField);
        removeButtons.forEach((button) => {
            button.click();
        });
    }

    function extractFilenameFromRemoveAriaLabel(label) {
        if (typeof label !== 'string' || !label.trim()) {
            return '';
        }

        const strings = getUiStrings();
        const prefixes = [
            strings.removeFile,
            'close',
            'Close',
            'Remove',
            'remove',
        ].filter(Boolean);

        for (const prefix of prefixes) {
            if (label.startsWith(`${prefix} `)) {
                return label.slice(prefix.length + 1).trim();
            }
        }

        return '';
    }

    function getVisibleNativeComposerAttachmentNameCandidatesFromChip(chip) {
        if (!chip) {
            return [];
        }

        const candidates = [];
        const addCandidate = (value) => {
            const candidate = typeof value === 'string' ? value.trim() : '';
            if (candidate && !candidates.includes(candidate)) {
                candidates.push(candidate);
            }
        };

        const cancelLabel = chip.querySelector('button[data-test-id="cancel-button"], .gem-attachment-close-button button')?.getAttribute('aria-label');
        addCandidate(extractFilenameFromRemoveAriaLabel(cancelLabel));
        addCandidate(chip.querySelector('[title]')?.getAttribute('title'));
        addCandidate(chip.querySelector('.gem-attachment-text')?.textContent);
        addCandidate(chip.querySelector('[data-test-id="filename-label"]')?.textContent);
        addCandidate(chip.querySelector('[data-test-id="file-name"], .file-name')?.textContent);

        return candidates;
    }

    function getAttachmentNameMatchKeys(filename) {
        const normalized = typeof filename === 'string' ? filename.trim() : '';
        if (!normalized) {
            return [];
        }

        const displayName = formatAttachmentDisplayName({ filename: normalized });
        return [normalized, stripAttachmentExtension(normalized), displayName]
            .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
            .filter((value, index, values) => value && values.indexOf(value) === index);
    }

    function getVisibleAttachmentNameMatchKeys(filename) {
        const normalized = typeof filename === 'string' ? filename.trim() : '';
        if (!normalized) {
            return [];
        }

        if (getAttachmentFileExtension(normalized)) {
            return [normalized.toLowerCase()];
        }

        return getAttachmentNameMatchKeys(normalized);
    }

    function getVisibleNativeComposerAttachmentFilenames(textInputField) {
        const field = textInputField || getTextInputField();
        if (!field) {
            return [];
        }

        const filenames = [];
        const nativeChips = Array.from(field.querySelectorAll(`uploader-file-preview:not([${ATTRS.attachmentOwned}="true"])`));
        nativeChips.forEach((chip) => {
            filenames.push(...getVisibleNativeComposerAttachmentNameCandidatesFromChip(chip));
        });

        return filenames;
    }

    function parseAttachmentDurationLabel(value) {
        if (typeof value !== 'string') {
            return null;
        }

        const parts = value.trim().split(':').map((part) => Number(part));
        if (!parts.length || parts.some((part) => !Number.isFinite(part) || part < 0)) {
            return null;
        }

        return parts.reduce((total, part) => (total * 60) + part, 0);
    }

    function getVisibleNativeComposerAttachmentDetails(textInputField) {
        const field = textInputField || getTextInputField();
        if (!field) {
            return [];
        }

        return Array.from(field.querySelectorAll(`uploader-file-preview:not([${ATTRS.attachmentOwned}="true"])`))
            .map((chip) => {
                const nameCandidates = getVisibleNativeComposerAttachmentNameCandidatesFromChip(chip);
                const filename = nameCandidates[0] || '';
                const imagePreview = chip.querySelector('img[data-test-id="image-preview"], .gem-attachment-style-img');
                const videoPreview = chip.querySelector('img[data-test-id="video-preview"]');
                const previewUrl = normalizeAttachmentMatchUrl(
                    imagePreview?.getAttribute('src')
                    || videoPreview?.getAttribute('src')
                    || '',
                );
                const durationSeconds = parseAttachmentDurationLabel(
                    chip.querySelector('[data-test-id="video-timecode"], .time-overlay span')?.textContent || '',
                );

                return {
                    filename,
                    nameCandidates,
                    previewUrl,
                    viewUrl: previewUrl,
                    durationSeconds,
                };
            })
            .filter((attachment) => attachment.filename || attachment.previewUrl);
    }

    function filterNativePayloadAttachmentsByComposerUi(nativeAttachments, textInputField) {
        if (!Array.isArray(nativeAttachments) || !nativeAttachments.length) {
            return [];
        }

        const visibleDetails = getVisibleNativeComposerAttachmentDetails(textInputField);
        const visibleFilenames = visibleDetails.flatMap((attachment) => {
            return Array.isArray(attachment.nameCandidates)
                ? attachment.nameCandidates
                : [attachment.filename].filter(Boolean);
        });
        if (!visibleFilenames.length) {
            return visibleDetails.length
                ? nativeAttachments.slice(0, visibleDetails.length)
                : [];
        }

        const counts = new Map();
        visibleFilenames.forEach((filename) => {
            getVisibleAttachmentNameMatchKeys(filename).forEach((key) => {
                counts.set(key, (counts.get(key) || 0) + 1);
            });
        });

        return nativeAttachments.filter((attachmentRecord) => {
            const filename = typeof attachmentRecord?.[1] === 'string'
                ? attachmentRecord[1]
                : '';
            const matchKey = getAttachmentNameMatchKeys(filename).find((key) => {
                return (counts.get(key) || 0) > 0;
            });
            if (!matchKey) {
                return false;
            }

            counts.set(matchKey, (counts.get(matchKey) || 0) - 1);
            return true;
        });
    }

    function normalizeNativePayloadAttachments(nativeAttachments, textInputField) {
        if (!Array.isArray(nativeAttachments) || !nativeAttachments.length) {
            return [];
        }

        const uiAttachments = getVisibleNativeComposerAttachmentDetails(textInputField);
        return nativeAttachments
            .map((payloadRecord, index) => {
                const filename = typeof payloadRecord?.[1] === 'string' ? payloadRecord[1] : '';
                const payloadNameKeys = getAttachmentNameMatchKeys(filename);
                const matchingUiAttachment = uiAttachments.find((attachment) => {
                    const uiNameCandidates = Array.isArray(attachment.nameCandidates)
                        ? attachment.nameCandidates
                        : [attachment.filename];
                    return uiNameCandidates.some((candidate) => {
                        return getVisibleAttachmentNameMatchKeys(candidate).some((key) => payloadNameKeys.includes(key));
                    });
                }) || uiAttachments[index] || {};

                return normalizePayloadAttachmentRecord(payloadRecord, matchingUiAttachment);
            })
            .filter(Boolean);
    }

    function normalizeAttachmentMatchUrl(url) {
        return typeof url === 'string' ? url.trim() : '';
    }

    function getFallbackAttachmentMime(descriptor) {
        const extension = getAttachmentFileExtension(descriptor?.filename);
        if (descriptor?.kind === 'image') {
            return extension ? `image/${extension === 'jpg' ? 'jpeg' : extension}` : 'image/*';
        }

        if (descriptor?.kind === 'video') {
            return extension ? `video/${extension}` : 'video/*';
        }

        if (extension === 'pdf') {
            return 'application/pdf';
        }

        if (extension === 'zip') {
            return 'application/zip';
        }

        if (PLAIN_TEXT_FILE_EXTENSIONS.has(extension) || CODE_FILE_EXTENSIONS.has(extension)) {
            return 'text/plain';
        }

        return 'application/octet-stream';
    }

    function createFallbackAttachmentRecordsFromUserQueryUi(userQuery) {
        return getVisibleUserQueryAttachmentDescriptors(userQuery)
            .map((descriptor, index) => {
                const filename = descriptor.filename || '';
                const attachment = {
                    key: `ui:${descriptor.kind || 'file'}:${filename}:${descriptor.previewUrl || ''}:${index}`,
                    kind: descriptor.kind || 'file',
                    typeCode: descriptor.kind === 'image' ? 1 : (descriptor.kind === 'video' ? 2 : 0),
                    filename,
                    mime: getFallbackAttachmentMime(descriptor),
                    token: '',
                    previewUrl: descriptor.previewUrl || null,
                    downloadUrl: null,
                    viewUrl: descriptor.previewUrl || null,
                    width: null,
                    height: null,
                    durationSeconds: descriptor.durationSeconds ?? null,
                    payloadRecord: null,
                };

                attachment.typeLabel = formatAttachmentTypeLabel(attachment);
                attachment.displayName = formatAttachmentDisplayName(attachment)
                    || descriptor.displayName
                    || filename
                    || attachment.typeLabel;
                return attachment;
            })
            .filter((attachment) => attachment.filename || attachment.previewUrl);
    }

    function getVisibleUserQueryAttachmentDescriptors(userQuery) {
        if (!userQuery) {
            return [];
        }

        const previewNodes = Array.from(userQuery.querySelectorAll('user-query-file-preview'));
        const descriptorNodes = previewNodes.length ? previewNodes : [userQuery];
        const descriptors = [];
        descriptorNodes.forEach((node) => {
            const fileButton = node.querySelector(SELECTORS.userQueryFileButton);
            if (fileButton) {
                descriptors.push({
                    kind: 'file',
                    filename: fileButton.getAttribute('aria-label')?.trim() || '',
                    displayName: node.querySelector('[data-test-id="filename-label"], .filename-label')?.textContent?.trim() || '',
                    previewUrl: '',
                    durationSeconds: null,
                });
                return;
            }

            const imagePreview = node.querySelector(SELECTORS.userQueryImagePreview);
            if (imagePreview) {
                descriptors.push({
                    kind: 'image',
                    filename: '',
                    previewUrl: normalizeAttachmentMatchUrl(imagePreview.getAttribute('src')),
                    durationSeconds: null,
                });
                return;
            }

            const videoPreview = node.querySelector(SELECTORS.userQueryVideoPreview);
            if (videoPreview) {
                descriptors.push({
                    kind: 'video',
                    filename: '',
                    previewUrl: normalizeAttachmentMatchUrl(videoPreview.getAttribute('src')),
                    durationSeconds: parseAttachmentDurationLabel(
                        node.querySelector('.video-timecode')?.textContent || '',
                    ),
                });
            }
        });

        if (descriptors.length) {
            return descriptors;
        }

        userQuery.querySelectorAll(SELECTORS.userQueryFileButton).forEach((button) => {
            descriptors.push({
                kind: 'file',
                filename: button.getAttribute('aria-label')?.trim() || '',
                displayName: button.querySelector('[data-test-id="filename-label"], .filename-label')?.textContent?.trim() || '',
                previewUrl: '',
                durationSeconds: null,
            });
        });
        userQuery.querySelectorAll(SELECTORS.userQueryImagePreview).forEach((image) => {
            descriptors.push({
                kind: 'image',
                filename: '',
                previewUrl: normalizeAttachmentMatchUrl(image.getAttribute('src')),
                durationSeconds: null,
            });
        });
        userQuery.querySelectorAll(SELECTORS.userQueryVideoPreview).forEach((image) => {
            descriptors.push({
                kind: 'video',
                filename: '',
                previewUrl: normalizeAttachmentMatchUrl(image.getAttribute('src')),
                durationSeconds: parseAttachmentDurationLabel(
                    image.closest('user-query-file-preview')?.querySelector('.video-timecode')?.textContent || '',
                ),
            });
        });

        return descriptors.filter((descriptor) => descriptor.filename || descriptor.previewUrl || descriptor.kind);
    }

    function filterCachedAttachmentsByUserQueryUi(attachments, userQuery) {
        if (!Array.isArray(attachments) || !attachments.length) {
            return [];
        }

        const descriptors = getVisibleUserQueryAttachmentDescriptors(userQuery);
        if (!descriptors.length) {
            return [];
        }

        const usedAttachmentIndexes = new Set();
        const findAttachmentIndex = (descriptor) => {
            const normalizedPreviewUrl = normalizeAttachmentMatchUrl(descriptor.previewUrl);

            if (descriptor.filename) {
                const filenameIndex = attachments.findIndex((attachment, index) => {
                    return !usedAttachmentIndexes.has(index) && attachment?.filename === descriptor.filename;
                });
                if (filenameIndex !== -1) {
                    return filenameIndex;
                }
            }

            if (normalizedPreviewUrl) {
                const previewIndex = attachments.findIndex((attachment, index) => {
                    return !usedAttachmentIndexes.has(index) && [
                        attachment?.previewUrl,
                        attachment?.viewUrl,
                    ]
                        .map(normalizeAttachmentMatchUrl)
                        .includes(normalizedPreviewUrl);
                });
                if (previewIndex !== -1) {
                    return previewIndex;
                }
            }

            return attachments.findIndex((attachment, index) => {
                return !usedAttachmentIndexes.has(index) && attachment?.kind === descriptor.kind;
            });
        };

        return descriptors
            .map((descriptor) => {
                const index = findAttachmentIndex(descriptor);
                if (index === -1) {
                    return null;
                }

                usedAttachmentIndexes.add(index);
                const attachment = cloneAttachmentRecord(attachments[index]);
                if (!attachment) {
                    return null;
                }

                if ((descriptor.kind === 'image' || descriptor.kind === 'video') && descriptor.previewUrl) {
                    attachment.kind = descriptor.kind;
                    attachment.typeCode = descriptor.kind === 'image' ? 1 : 2;
                    attachment.previewUrl = descriptor.previewUrl;
                    attachment.viewUrl = attachment.viewUrl || descriptor.previewUrl;
                    attachment.durationSeconds = attachment.durationSeconds ?? descriptor.durationSeconds ?? null;
                    attachment.typeLabel = formatAttachmentTypeLabel(attachment);
                    attachment.displayName = formatAttachmentDisplayName(attachment);
                }

                return attachment;
            })
            .filter(Boolean);
    }

    function findCachedAttachmentsByUserQueryUi(conversationId, userQuery) {
        const descriptors = getVisibleUserQueryAttachmentDescriptors(userQuery);
        if (!descriptors.length || !state.attachmentCache.size) {
            return [];
        }

        let bestMatch = [];
        state.attachmentCache.forEach((attachments, cacheKey) => {
            if (
                conversationId
                && typeof cacheKey === 'string'
                && !cacheKey.startsWith(`${conversationId}::`)
            ) {
                return;
            }

            const filtered = filterCachedAttachmentsByUserQueryUi(attachments, userQuery);
            if (filtered.length > bestMatch.length) {
                bestMatch = filtered.map(cloneAttachmentRecord).filter(Boolean);
            }
        });

        return bestMatch.length === descriptors.length ? bestMatch : [];
    }

    function removePendingAttachment(attachmentKey) {
        if (!state.pendingOverride?.attachments?.length) {
            return;
        }

        state.pendingOverride.attachments = state.pendingOverride.attachments.filter((attachment) => {
            return attachment?.key !== attachmentKey;
        });

        logDebug('Removed pending attachment from edit state.', {
            attachmentKey,
            remaining: state.pendingOverride.attachments.length,
        });
        syncEditComposerAttachmentUi();
    }

    function createAttachmentRemoveButton(attachment, contentScopeAttr) {
        const strings = getUiStrings();
        const attachmentLabel = attachment.filename || attachment.displayName || attachment.typeLabel || strings.unknownType;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mdc-icon-button mat-mdc-icon-button mat-mdc-button-base mat-badge mat-unthemed mat-badge-overlap mat-badge-above mat-badge-after mat-badge-small mat-badge-hidden ng-star-inserted';
        button.setAttribute('data-test-id', 'cancel-button');
        button.setAttribute('aria-label', `${strings.removeFile} ${attachmentLabel}`);
        button.setAttribute(ATTRS.attachmentOwned, 'true');

        const icon = createMaterialIcon('close');
        icon.classList.add('lm-icon-s');
        applyScopeAttribute(button, contentScopeAttr);
        applyScopeAttribute(icon, contentScopeAttr);
        button.appendChild(createPersistentRippleSpan('mdc-icon-button__ripple'));
        button.appendChild(icon);
        button.appendChild(createClassSpan('mat-focus-indicator'));
        button.appendChild(createClassSpan('mat-mdc-button-touch-target'));
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            removePendingAttachment(attachment.key);
        });
        return button;
    }

    function createClassSpan(className) {
        const span = document.createElement('span');
        span.className = className;
        return span;
    }

    function createPersistentRippleSpan(className) {
        return createClassSpan(`mat-mdc-button-persistent-ripple ${className}`);
    }

    function createOwnedAttachmentCloseControl(attachment, scope, attachmentContentAttr) {
        const strings = getUiStrings();
        const attachmentLabel = attachment.filename || attachment.displayName || attachment.typeLabel || strings.unknownType;
        const host = document.createElement('gem-icon-button');
        host.className = 'gem-attachment-close-button gem-button gem-button-badge-size-small gem-button-size-xsmall gem-button-type-tonal lm-enabled ng-star-inserted';
        host.setAttribute('theme', 'lm');
        host.setAttribute('type', 'tonal');
        host.setAttribute('size', 'xsmall');
        host.setAttribute('arialabel', `${strings.removeFile} ${attachmentLabel}`);
        host.setAttribute(ATTRS.attachmentOwned, 'true');
        applyScopeAttribute(host, attachmentContentAttr);
        applyScopeAttribute(host, scope.iconButtonHostAttr);

        host.appendChild(createAttachmentRemoveButton(attachment, attachmentContentAttr));
        return host;
    }

    function createOwnedAttachmentMatChip(attachmentContentAttr) {
        const chip = document.createElement('mat-basic-chip');
        chip.className = 'mat-mdc-chip mat-ripple mat-primary mat-mdc-basic-chip ng-star-inserted';
        chip.setAttribute('matripple', '');
        chip.setAttribute(ATTRS.attachmentOwned, 'true');
        applyScopeAttribute(chip, attachmentContentAttr);

        const focusOverlay = createClassSpan('mat-mdc-chip-focus-overlay');
        const cell = createClassSpan('mdc-evolution-chip__cell mdc-evolution-chip__cell--primary');
        const action = createClassSpan('mat-mdc-chip-action mdc-evolution-chip__action mdc-evolution-chip__action--presentational mdc-evolution-chip__action--primary');
        action.setAttribute('aria-disabled', 'false');
        const label = createClassSpan('mdc-evolution-chip__text-label mat-mdc-chip-action-label');
        const focusIndicator = createClassSpan('mat-mdc-chip-primary-focus-indicator mat-focus-indicator');

        [focusOverlay, cell, action, label, focusIndicator].forEach((node) => {
            applyScopeAttribute(node, attachmentContentAttr);
        });

        action.appendChild(label);
        action.appendChild(focusIndicator);
        cell.appendChild(action);
        chip.appendChild(focusOverlay);
        chip.appendChild(cell);
        return { chip, label };
    }

    function createOwnedAttachmentShell(textInputField, attachment) {
        const scope = getComposerScopeAttributes(textInputField);
        const chip = document.createElement('uploader-file-preview');
        chip.className = 'file-preview-chip ng-star-inserted';
        chip.setAttribute(ATTRS.attachmentOwned, 'true');
        chip.setAttribute(ATTRS.attachmentKey, attachment.key);
        applyScopeAttribute(chip, scope.previewChipContentAttr);
        applyScopeAttribute(chip, scope.previewChipHostAttr);

        const container = document.createElement('div');
        container.className = 'mat-mdc-tooltip-trigger file-preview-container lm-enabled';
        container.setAttribute(ATTRS.attachmentOwned, 'true');
        container.setAttribute(ATTRS.tooltip, attachment.filename || attachment.displayName || attachment.typeLabel || '');
        applyScopeAttribute(container, scope.previewInnerContentAttr);

        chip.appendChild(container);
        return { chip, container, scope };
    }

    function createOwnedFileAttachmentChip(textInputField, attachment) {
        const { chip, container, scope } = createOwnedAttachmentShell(textInputField, attachment);
        const attachmentHost = document.createElement('gem-attachment');
        attachmentHost.className = 'gem-attachment gds-label-l gem-attachment-tile lm-enabled ng-star-inserted';
        attachmentHost.setAttribute('tabindex', '0');
        attachmentHost.setAttribute(ATTRS.attachmentOwned, 'true');
        applyScopeAttribute(attachmentHost, scope.previewInnerContentAttr);
        applyScopeAttribute(attachmentHost, scope.fileAttachmentHostAttr);

        const { chip: matChip, label } = createOwnedAttachmentMatChip(scope.fileAttachmentContentAttr);
        const content = document.createElement('span');
        content.className = 'gem-attachment-content ng-star-inserted';
        content.setAttribute(ATTRS.attachmentOwned, 'true');
        applyScopeAttribute(content, scope.fileAttachmentContentAttr);

        const iconHost = document.createElement('gem-icon');
        iconHost.className = 'gem-attachment-icon ng-star-inserted';
        iconHost.setAttribute('size', 'large');
        iconHost.setAttribute(ATTRS.attachmentOwned, 'true');
        applyScopeAttribute(iconHost, scope.fileAttachmentContentAttr);

        const icon = document.createElement('img');
        icon.className = 'lm-icon-l ng-star-inserted';
        icon.setAttribute('data-test-id', 'file-icon-img');
        icon.src = getAttachmentIconUrl(attachment);
        icon.alt = getAttachmentIconAltText(attachment);
        applyScopeAttribute(icon, scope.fileAttachmentContentAttr);
        iconHost.appendChild(icon);

        const name = document.createElement('span');
        name.className = 'gem-attachment-text gds-body-s ng-star-inserted';
        name.setAttribute('data-test-id', 'file-name');
        name.title = attachment.filename;
        name.textContent = attachment.displayName || stripAttachmentExtension(attachment.filename) || attachment.filename;
        applyScopeAttribute(name, scope.fileAttachmentContentAttr);

        content.appendChild(iconHost);
        content.appendChild(name);
        content.appendChild(createOwnedAttachmentCloseControl(attachment, scope, scope.fileAttachmentContentAttr));
        label.appendChild(content);
        attachmentHost.appendChild(matChip);
        container.appendChild(attachmentHost);
        return chip;
    }

    function createOwnedImageAttachmentChip(textInputField, attachment) {
        const { chip, container, scope } = createOwnedAttachmentShell(textInputField, attachment);
        const attachmentHost = document.createElement('gem-media-attachment');
        attachmentHost.className = 'gem-attachment gds-label-l clickable gem-attachment-tile lm-enabled ng-star-inserted';
        attachmentHost.setAttribute('tabindex', '0');
        attachmentHost.setAttribute(ATTRS.attachmentOwned, 'true');
        if (attachment.viewUrl) {
            attachmentHost.addEventListener('click', () => {
                window.open(attachment.viewUrl, '_blank', 'noopener,noreferrer');
            });
        }
        applyScopeAttribute(attachmentHost, scope.previewInnerContentAttr);
        applyScopeAttribute(attachmentHost, scope.mediaAttachmentHostAttr);

        const { chip: matChip, label } = createOwnedAttachmentMatChip(scope.mediaAttachmentContentAttr);
        const image = document.createElement('img');
        image.className = 'gem-attachment-style-img ng-star-inserted';
        image.setAttribute('data-test-id', 'image-preview');
        image.setAttribute('aria-label', getUiStrings().imagePreview);
        image.alt = 'attachment';
        image.src = attachment.previewUrl || attachment.viewUrl || '';
        applyScopeAttribute(image, scope.mediaAttachmentContentAttr);

        const content = document.createElement('span');
        content.className = 'gem-attachment-content ng-star-inserted';
        content.setAttribute(ATTRS.attachmentOwned, 'true');
        applyScopeAttribute(content, scope.mediaAttachmentContentAttr);

        content.appendChild(createOwnedAttachmentCloseControl(attachment, scope, scope.mediaAttachmentContentAttr));
        label.appendChild(image);
        label.appendChild(content);
        attachmentHost.appendChild(matChip);
        container.appendChild(attachmentHost);
        return chip;
    }

    function createOwnedVideoAttachmentChip(textInputField, attachment) {
        const strings = getUiStrings();
        const { chip, container, scope } = createOwnedAttachmentShell(textInputField, attachment);
        const attachmentHost = document.createElement('gem-media-attachment');
        attachmentHost.className = 'gem-attachment gds-label-l clickable gem-attachment-tile lm-enabled ng-star-inserted';
        attachmentHost.setAttribute('tabindex', '0');
        attachmentHost.setAttribute(ATTRS.attachmentOwned, 'true');
        applyScopeAttribute(attachmentHost, scope.previewInnerContentAttr);
        applyScopeAttribute(attachmentHost, scope.mediaAttachmentHostAttr);

        const { chip: matChip, label } = createOwnedAttachmentMatChip(scope.mediaAttachmentContentAttr);
        const image = document.createElement('img');
        image.className = 'gem-attachment-style-img ng-star-inserted';
        image.setAttribute('data-test-id', 'video-preview');
        image.setAttribute('aria-label', strings.videoPreview);
        image.alt = 'attachment';
        image.src = attachment.previewUrl || attachment.viewUrl || '';
        applyScopeAttribute(image, scope.mediaAttachmentContentAttr);

        const content = document.createElement('span');
        content.className = 'gem-attachment-content ng-star-inserted';
        content.setAttribute(ATTRS.attachmentOwned, 'true');
        applyScopeAttribute(content, scope.mediaAttachmentContentAttr);

        const durationLabel = formatAttachmentDuration(attachment.durationSeconds);
        if (durationLabel) {
            const timecodeWrapper = document.createElement('div');
            timecodeWrapper.className = 'time-overlay ng-star-inserted';
            applyScopeAttribute(timecodeWrapper, scope.mediaAttachmentContentAttr);
            const playIconHost = document.createElement('gem-icon');
            playIconHost.setAttribute('size', 'small');
            applyScopeAttribute(playIconHost, scope.mediaAttachmentContentAttr);
            const playIcon = createMaterialIcon('play_arrow');
            playIcon.classList.add('lm-icon-s');
            applyScopeAttribute(playIcon, scope.mediaAttachmentContentAttr);
            playIconHost.appendChild(playIcon);
            const timecode = document.createElement('span');
            timecode.setAttribute('data-test-id', 'video-timecode');
            timecode.className = 'gds-emphasized-body-s video-timecode';
            timecode.textContent = durationLabel;
            applyScopeAttribute(timecode, scope.mediaAttachmentContentAttr);
            timecodeWrapper.appendChild(playIconHost);
            timecodeWrapper.appendChild(timecode);
            content.appendChild(timecodeWrapper);
        }
        content.appendChild(createOwnedAttachmentCloseControl(attachment, scope, scope.mediaAttachmentContentAttr));

        label.appendChild(image);
        label.appendChild(content);
        attachmentHost.appendChild(matChip);
        container.appendChild(attachmentHost);
        return chip;
    }

    function createOwnedAttachmentChip(textInputField, attachment) {
        if (attachment.kind === 'image' && (attachment.previewUrl || attachment.viewUrl)) {
            return createOwnedImageAttachmentChip(textInputField, attachment);
        }

        if (attachment.kind === 'video' && (attachment.previewUrl || attachment.viewUrl)) {
            return createOwnedVideoAttachmentChip(textInputField, attachment);
        }

        return createOwnedFileAttachmentChip(textInputField, attachment);
    }

    function getOwnedComposerAttachmentNodes(container) {
        if (!container) {
            return [];
        }

        return Array.from(container.children).filter((node) => {
            return node.nodeType === Node.ELEMENT_NODE && node.getAttribute(ATTRS.attachmentOwned) === 'true';
        });
    }

    function removeOwnedAttachmentUi(textInputField) {
        const field = textInputField || getTextInputField();
        if (!field) {
            return;
        }

        if (state.tooltipTarget?.closest?.(`[${ATTRS.attachmentOwned}="true"]`)) {
            hideOwnedTooltip();
        }

        field.querySelectorAll(`uploader-file-preview[${ATTRS.attachmentOwned}="true"]`).forEach((node) => {
            node.remove();
        });

        const ownedWrapper = field.querySelector(SELECTORS.ownedAttachmentPreviewWrapper);
        if (ownedWrapper) {
            ownedWrapper.remove();
        }

        if (!field.querySelector(SELECTORS.attachmentPreviewWrapper)) {
            field.classList.remove('with-file-preview');
        }
    }

    function ensureOwnedAttachmentContainer(textInputField) {
        const nativeWrapper = textInputField.querySelector(SELECTORS.nativeAttachmentPreviewWrapper);
        if (nativeWrapper) {
            textInputField.querySelector(SELECTORS.ownedAttachmentPreviewWrapper)?.remove();
            return nativeWrapper.querySelector(SELECTORS.attachmentPreviewContainer);
        }

        const scope = getComposerScopeAttributes(textInputField);
        let ownedWrapper = textInputField.querySelector(SELECTORS.ownedAttachmentPreviewWrapper);
        if (!ownedWrapper) {
            ownedWrapper = document.createElement('div');
            ownedWrapper.className = 'attachment-preview-wrapper ng-star-inserted';
            ownedWrapper.setAttribute(ATTRS.attachmentOwned, 'true');
            applyScopeAttribute(ownedWrapper, scope.inputContentAttr);
            textInputField.insertBefore(ownedWrapper, textInputField.firstChild);
        }

        let ownedContainer = ownedWrapper.querySelector(SELECTORS.ownedAttachmentPreviewContainer);
        if (!ownedContainer) {
            ownedContainer = document.createElement('uploader-file-preview-container');
            ownedContainer.className = 'uploader-file-preview-container ng-star-inserted';
            ownedContainer.setAttribute(ATTRS.attachmentOwned, 'true');
            applyScopeAttribute(ownedContainer, scope.inputContentAttr);
            applyScopeAttribute(ownedContainer, scope.previewContainerHostAttr);
            ownedWrapper.appendChild(ownedContainer);
        }

        return ownedContainer;
    }

    function syncEditComposerAttachmentUi() {
        const textInputField = getTextInputField();
        const attachments = Array.isArray(state.pendingOverride?.attachments)
            ? state.pendingOverride.attachments
            : [];

        if (!textInputField) {
            return;
        }

        if (!attachments.length) {
            removeOwnedAttachmentUi(textInputField);
            return;
        }

        textInputField.classList.add('with-file-preview');
        const ownedContainer = ensureOwnedAttachmentContainer(textInputField);
        if (!ownedContainer) {
            return;
        }

        const nextKeys = attachments.map((attachment) => attachment.key);
        const currentKeys = getOwnedComposerAttachmentNodes(ownedContainer).map((node) => {
            return node.getAttribute(ATTRS.attachmentKey);
        });

        const needsRender = nextKeys.length !== currentKeys.length
            || nextKeys.some((key, index) => key !== currentKeys[index]);

        if (!needsRender) {
            return;
        }

        const fragment = document.createDocumentFragment();
        attachments.forEach((attachment) => {
            fragment.appendChild(createOwnedAttachmentChip(textInputField, attachment));
        });

        const nativeWrapper = textInputField.querySelector(SELECTORS.nativeAttachmentPreviewWrapper);
        if (nativeWrapper) {
            const firstNativeNode = Array.from(ownedContainer.children).find((node) => {
                return node.nodeType === Node.ELEMENT_NODE && node.getAttribute(ATTRS.attachmentOwned) !== 'true';
            }) || null;

            getOwnedComposerAttachmentNodes(ownedContainer).forEach((node) => {
                node.remove();
            });
            ownedContainer.insertBefore(fragment, firstNativeNode);
            return;
        }

        ownedContainer.replaceChildren(fragment);
    }

    function parsePixelValue(value) {
        if (typeof value !== 'string') {
            return null;
        }

        const match = value.trim().match(/^(-?\d+(?:\.\d+)?)px$/);
        if (!match) {
            return null;
        }

        const pixels = Number(match[1]);
        return Number.isFinite(pixels) && pixels > 0 ? pixels : null;
    }

    function getPendingConversationMinHeight(targetContainer) {
        const containers = getConversationContainers();
        const lastContainer = containers[containers.length - 1] ?? null;
        const candidates = [];

        if (lastContainer) {
            candidates.push(lastContainer);
        }

        if (targetContainer && targetContainer !== lastContainer) {
            candidates.push(targetContainer);
        }

        for (const container of candidates) {
            const inlineMinHeight = parsePixelValue(container.style?.minHeight || '');
            if (inlineMinHeight) {
                return `${Math.round(inlineMinHeight)}px`;
            }

            const computedMinHeight = parsePixelValue(window.getComputedStyle(container).minHeight);
            if (computedMinHeight) {
                return `${Math.round(computedMinHeight)}px`;
            }
        }

        return null;
    }

    function getOptimisticConversationMinHeight(targetContainer) {
        const pendingMinHeight = parsePixelValue(getPendingConversationMinHeight(targetContainer) || '');
        const targetRect = targetContainer?.getBoundingClientRect?.();
        const remainingViewportHeight = targetRect
            ? Math.max(0, Math.round(window.innerHeight - targetRect.top))
            : 0;
        const nextMinHeight = Math.max(pendingMinHeight || 0, remainingViewportHeight || 0);

        return nextMinHeight > 0 ? `${nextMinHeight}px` : null;
    }

    function copyAngularScopeAttributes(source, target) {
        if (!source?.attributes || !target) {
            return;
        }

        Array.from(source.attributes).forEach((attribute) => {
            if (attribute.name.startsWith('_ngcontent-') || attribute.name.startsWith('_nghost-')) {
                target.setAttribute(attribute.name, attribute.value);
            }
        });
    }

    function cloneResponseShellNode(source, fallbackTag, fallbackClassName) {
        const node = source ? source.cloneNode(false) : document.createElement(fallbackTag);
        if (!source && fallbackClassName) {
            node.className = fallbackClassName;
        }

        node.removeAttribute('id');
        node.removeAttribute('jslog');
        node.removeAttribute('aria-describedby');
        node.removeAttribute('cdk-describedby-host');
        return node;
    }

    function stripClonedResponseRuntimeAttributes(root) {
        root.removeAttribute('id');
        root.removeAttribute('jslog');
        root.removeAttribute('aria-describedby');
        root.removeAttribute('cdk-describedby-host');
        root.querySelectorAll('[jslog], [aria-describedby], [cdk-describedby-host]').forEach((node) => {
            node.removeAttribute('jslog');
            node.removeAttribute('aria-describedby');
            node.removeAttribute('cdk-describedby-host');
        });
        root.querySelectorAll('[id]').forEach((node) => {
            if (typeof SVGElement === 'undefined' || !(node instanceof SVGElement)) {
                node.removeAttribute('id');
            }
        });
    }

    function uniquifyClonedSvgIds(root) {
        root.querySelectorAll('svg').forEach((svg, svgIndex) => {
            const idNodes = Array.from(svg.querySelectorAll('[id]'));
            if (!idNodes.length) {
                return;
            }

            const suffix = `gemini-editor-${Date.now().toString(36)}-${svgIndex}-${Math.random().toString(36).slice(2)}`;
            const idMap = new Map();
            idNodes.forEach((node) => {
                const oldId = node.getAttribute('id');
                if (!oldId) {
                    return;
                }

                const newId = `${oldId}-${suffix}`;
                idMap.set(oldId, newId);
                node.setAttribute('id', newId);
            });

            if (!idMap.size) {
                return;
            }

            const updateReferenceValue = (value) => {
                let nextValue = value.replace(/url\(#([^)]+)\)/g, (match, id) => {
                    return idMap.has(id) ? `url(#${idMap.get(id)})` : match;
                });

                if (nextValue.startsWith('#') && idMap.has(nextValue.slice(1))) {
                    nextValue = `#${idMap.get(nextValue.slice(1))}`;
                }

                return nextValue;
            };

            [svg, ...Array.from(svg.querySelectorAll('*'))].forEach((node) => {
                Array.from(node.attributes || []).forEach((attribute) => {
                    if (attribute.value.includes('#')) {
                        node.setAttribute(attribute.name, updateReferenceValue(attribute.value));
                    }
                });
            });
        });
    }

    const THINKING_DOTS_DOT_PATH = ' M4,0 C4,0 4,0 4,0 C4,2.2076001167297363 2.2076001167297363,4 0,4 C0,4 0,4 0,4 C-2.2076001167297363,4 -4,2.2076001167297363 -4,0 C-4,0 -4,0 -4,0 C-4,-2.2076001167297363 -2.2076001167297363,-4 0,-4 C0,-4 0,-4 0,-4 C2.2076001167297363,-4 4,-2.2076001167297363 4,0z';

    const THINKING_DOTS_ANIMATION = {
        fr: 60.0914611816406,
        ip: 0,
        op: 693.005318581434,
        center: {
            p: [14, 14],
            a: [50, 50],
            r: [
                [192.001, [0], [0.566, 1], [0.435, 0]],
                [235.002, [-120], [0.667, 1], [0.333, 0]],
                [481.004, [-120], [0.226, 1], [0.274, 0]],
                [536.004113650287, [-360]],
            ],
        },
        layers: [
            {
                nm: 'LEFT',
                s: [50, 50],
                p: [
                    [0, [43.4, 53.744], [0.559, 1], [0.243, 0.609], [0, 0], [0, 0]],
                    [12, [43.4, 55], [0.34, 1], [0.516, 0.008], [0, 0], [0, 0]],
                    [48, [43.4, 45], [0.34, 1], [0.516, 0.008], [0, 0], [0, 0]],
                    [84.001, [43.4, 55], [0.34, 1], [0.516, 0.008], [0, 0], [0, 0]],
                    [120.001, [43.4, 45], [0.34, 1], [0.516, 0.008], [0, 0], [0, 0]],
                    [156.001, [43.4, 55], [0.667, 1], [0.516, 0.008], [0, 0], [-0.04, 3.987]],
                    [192.001, [43.4, 45], [0.667, 1], [0.333, 0], [-0.212, 14.619], [0, 0]],
                    [235.002, [53.212, 59.625], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [268.002, [43.4, 43.1], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [301.002, [53.212, 59.625], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [337.003, [43.4, 43.1], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [373.003, [53.212, 59.625], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [409.003, [43.4, 43.1], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [445.003, [53.212, 59.625], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [481.004, [43.4, 43.1], [0.34, 1], [0.333, 0], [0, 0], [0, 0]],
                    [524.004, [43.4, 45], null, null, null, null, 1],
                    [536.004, [43.4, 45], [0.34, 1], [0.516, 0.005], [0, 0], [0, 0]],
                    [560.004, [43.4, 55], [0.34, 1], [0.516, 0.008], [0, 0], [0, 0]],
                    [596.005, [43.4, 45], [0.34, 1], [0.516, 0.008], [0, 0], [0, 0]],
                    [632.005, [43.4, 55], [0.34, 1], [0.516, 0.008], [0, 0], [0, 0]],
                    [668.005, [43.4, 45], [0.576, 0.694], [0.601, 0.007], [0, 0], [0, 0]],
                    [692.005310906713, [43.4, 53.744]],
                ],
            },
            {
                nm: 'CENTER',
                s: [50, 50],
                p: [
                    [0, [50, 47.037], [0.468, 1], [0.313, 0.367], [0, 0], [0, 0]],
                    [24, [50, 55], [0.5, 1], [0.5, 0], [0, 0], [0, 0]],
                    [60, [50, 45], [0.5, 1], [0.5, 0], [0, 0], [0, 0]],
                    [96.001, [50, 55], [0.5, 1], [0.5, 0], [0, 0], [0, 0]],
                    [132.001, [50, 45], [0.5, 1], [0.5, 0], [0, 0], [0, 0]],
                    [168.001, [50, 55], [0.833, 0.833], [0.5, 0], [0, 0], [3.375, 2.938]],
                    [204.002, [50, 45], [0.667, 1], [0.167, 0.167], [-4.316, -3.756], [0, 0]],
                    [235.002, [40.688, 47.75], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [268.002, [59.562, 47.75], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [301.002, [40.688, 47.75], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [337.003, [59.562, 47.75], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [373.003, [40.688, 47.75], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [409.003, [59.562, 47.75], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [445.003, [40.688, 47.75], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [481.004, [59.562, 47.75], [0.5, 1], [0.333, 0], [0, 0], [0, 0]],
                    [522.004, [50, 45], null, null, null, null, 1],
                    [536.004, [50, 45], [0.5, 1], [0.5, 0], [0, 0], [0, 0]],
                    [572.004, [50, 55], [0.5, 1], [0.5, 0], [0, 0], [0, 0]],
                    [608.005, [50, 45], [0.5, 1], [0.5, 0], [0, 0], [0, 0]],
                    [644.005, [50, 55], [0.5, 1], [0.5, 0], [0, 0], [0, 0]],
                    [680.005, [50, 45], [0.744, 0.413], [0.435, 0], [0, 0], [0, 0]],
                    [692.005310906713, [50, 47.037]],
                ],
            },
            {
                nm: 'RIGHT',
                s: [50, 50],
                p: [
                    [0, [56.6, 45], [0.5, 1], [0.5, 0], [0, 0], [0, 0]],
                    [36, [56.6, 55], [0.5, 1], [0.5, 0], [0, 0], [0, 0]],
                    [72.001, [56.6, 45], [0.5, 1], [0.5, 0], [0, 0], [0, 0]],
                    [108.001, [56.6, 55], [0.5, 1], [0.5, 0], [0, 0], [0, 0]],
                    [144.001, [56.6, 45], [0.5, 1], [0.5, 0], [0, 0], [0, 0]],
                    [180.001, [56.6, 55], [0.5, 1], [0.5, 0], [0, 0], [-0.133, 3.463]],
                    [235.002, [56.6, 43.1], [0.667, 1], [0.5, 0], [-6.076, 10.768], [0, 0]],
                    [268.002, [47.225, 59.438], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [301.002, [56.6, 43.1], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [337.003, [47.225, 59.438], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [373.003, [56.6, 43.1], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [409.003, [47.225, 59.438], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [445.003, [56.6, 43.1], [0.667, 1], [0.333, 0], [0, 0], [0, 0]],
                    [481.004, [47.225, 59.438], [0.5, 1], [0.333, 0], [0, 0], [0, 0]],
                    [536.004, [56.6, 45], [0.5, 1], [0.5, 0], [0, 0], [0, 0]],
                    [584.004, [56.6, 55], [0.5, 1], [0.5, 0], [0, 0], [0, 0]],
                    [620.005, [56.6, 45], [0.5, 1], [0.5, 0], [0, 0], [0, 0]],
                    [656.005, [56.6, 55], [0.5, 1], [0.5, 0], [0, 0], [0, 0]],
                    [692.005310906713, [56.6, 45]],
                ],
            },
        ],
    };

    function getThinkingDotsRenderLayers() {
        return ['RIGHT', 'CENTER', 'LEFT']
            .map((name) => THINKING_DOTS_ANIMATION.layers.find((layer) => layer.nm === name))
            .filter(Boolean);
    }

    function hasNonZeroVector(vector) {
        return Array.isArray(vector) && vector.some((value) => Math.abs(value || 0) > 0.000001);
    }

    function solveCubicBezier(x1, y1, x2, y2, x) {
        if (x <= 0 || (x1 === y1 && x2 === y2)) {
            return x;
        }

        if (x >= 1) {
            return 1;
        }

        const cx = 3 * x1;
        const bx = 3 * (x2 - x1) - cx;
        const ax = 1 - cx - bx;
        const cy = 3 * y1;
        const by = 3 * (y2 - y1) - cy;
        const ay = 1 - cy - by;
        let t = x;

        for (let i = 0; i < 8; i += 1) {
            const currentX = ((ax * t + bx) * t + cx) * t - x;
            const derivative = (3 * ax * t + 2 * bx) * t + cx;
            if (Math.abs(currentX) < 0.000001 || Math.abs(derivative) < 0.000001) {
                break;
            }
            t -= currentX / derivative;
        }

        if (t < 0 || t > 1) {
            let low = 0;
            let high = 1;
            for (let i = 0; i < 24; i += 1) {
                const mid = (low + high) / 2;
                const midX = ((ax * mid + bx) * mid + cx) * mid;
                if (midX < x) {
                    low = mid;
                } else {
                    high = mid;
                }
            }
            t = (low + high) / 2;
        }

        return ((ay * t + by) * t + cy) * t;
    }

    function interpolateThinkingDotsValue(start, end, progress, keyframe, nextKeyframe) {
        const dimensions = Math.max(start.length, end.length);
        const outgoing = keyframe[3] || [0, 0];
        const incoming = keyframe[2] || [1, 1];
        const easedProgress = solveCubicBezier(
            outgoing[0] ?? 0,
            outgoing[1] ?? 0,
            incoming[0] ?? 1,
            incoming[1] ?? 1,
            progress,
        );
        const spatialOut = keyframe[4] || null;
        const spatialIn = nextKeyframe[5] || null;
        const useSpatialCurve = hasNonZeroVector(spatialOut) || hasNonZeroVector(spatialIn);

        return Array.from({ length: dimensions }, (_, index) => {
            const startValue = start[index] ?? start[0] ?? 0;
            const endValue = end[index] ?? end[0] ?? startValue;
            if (!useSpatialCurve) {
                return startValue + ((endValue - startValue) * easedProgress);
            }

            const outHandle = startValue + (spatialOut?.[index] || 0);
            const inHandle = endValue + (spatialIn?.[index] || 0);
            const inverse = 1 - easedProgress;
            return (inverse ** 3 * startValue)
                + (3 * inverse ** 2 * easedProgress * outHandle)
                + (3 * inverse * easedProgress ** 2 * inHandle)
                + (easedProgress ** 3 * endValue);
        });
    }

    function getThinkingDotsKeyframeValue(keyframes, frame) {
        if (!Array.isArray(keyframes) || !keyframes.length) {
            return [0, 0];
        }

        if (frame <= keyframes[0][0]) {
            return keyframes[0][1];
        }

        for (let index = 0; index < keyframes.length - 1; index += 1) {
            const keyframe = keyframes[index];
            const nextKeyframe = keyframes[index + 1];
            const nextFrame = nextKeyframe[0];
            if (frame < nextFrame || index === keyframes.length - 2) {
                if (keyframe[6] === 1 || nextFrame === keyframe[0]) {
                    return keyframe[1];
                }

                const progress = Math.max(0, Math.min(1, (frame - keyframe[0]) / (nextFrame - keyframe[0])));
                return interpolateThinkingDotsValue(keyframe[1], nextKeyframe[1], progress, keyframe, nextKeyframe);
            }
        }

        return keyframes[keyframes.length - 1][1];
    }

    function formatThinkingDotsMatrixNumber(value) {
        if (!Number.isFinite(value) || Math.abs(value) < 0.000001) {
            return '0';
        }

        return String(Math.round(value * 1000000) / 1000000);
    }

    function getThinkingDotsLayerMatrix(layer, frame) {
        const center = THINKING_DOTS_ANIMATION.center;
        const rotation = getThinkingDotsKeyframeValue(center.r, frame)[0] || 0;
        const position = getThinkingDotsKeyframeValue(layer.p, frame);
        const radians = rotation * Math.PI / 180;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        const scaleX = (layer.s?.[0] ?? 100) / 100;
        const scaleY = (layer.s?.[1] ?? 100) / 100;
        const dx = (position[0] ?? 0) - center.a[0];
        const dy = (position[1] ?? 0) - center.a[1];

        return [
            cos * scaleX,
            sin * scaleX,
            -sin * scaleY,
            cos * scaleY,
            center.p[0] + (cos * dx) - (sin * dy),
            center.p[1] + (sin * dx) + (cos * dy),
        ];
    }

    function renderThinkingDotsFrame(dotGroups, dotLayers, frame) {
        dotGroups.forEach((dotGroup, index) => {
            const matrix = getThinkingDotsLayerMatrix(dotLayers[index], frame)
                .map(formatThinkingDotsMatrixNumber)
                .join(',');
            dotGroup.setAttribute('transform', `matrix(${matrix})`);
        });
    }

    function startThinkingDotsLottieAnimation(root, dotGroups, dotLayers) {
        const requestFrame = window.requestAnimationFrame
            ? window.requestAnimationFrame.bind(window)
            : ((callback) => window.setTimeout(() => callback(Date.now()), 16));
        const animation = THINKING_DOTS_ANIMATION;
        const durationFrames = animation.op - animation.ip;
        const startedAt = window.performance?.now?.() || Date.now();
        let hasConnected = false;

        const tick = (timestamp) => {
            const now = typeof timestamp === 'number' ? timestamp : Date.now();
            if (root.isConnected) {
                hasConnected = true;
            } else if (hasConnected || now - startedAt > 5000) {
                return;
            }

            const elapsedFrames = ((now - startedAt) / 1000) * animation.fr;
            const frame = animation.ip + (elapsedFrames % durationFrames);
            renderThinkingDotsFrame(dotGroups, dotLayers, frame);
            root.__geminiEditorThinkingDotsFrame = requestFrame(tick);
        };

        renderThinkingDotsFrame(dotGroups, dotLayers, animation.ip);
        root.__geminiEditorThinkingDotsFrame = requestFrame(tick);
    }

    function createThinkingDotsAnimation(sourceResponseNode) {
        const root = document.createElement('thinking-dots-animation');
        root.className = 'ng-star-inserted';
        root.setAttribute('data-gemini-editor-loading-dots', 'true');
        copyAngularScopeAttributes(sourceResponseNode, root);

        const wrapper = document.createElement('div');
        wrapper.className = 'thinking-dots-animation';
        wrapper.setAttribute('lottie-animation', '');
        copyAngularScopeAttributes(sourceResponseNode, wrapper);

        const svgNs = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('xmlns', svgNs);
        svg.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:xlink', 'http://www.w3.org/1999/xlink');
        svg.setAttribute('viewBox', '0 0 28 28');
        svg.setAttribute('width', '28');
        svg.setAttribute('height', '28');
        svg.setAttribute('style', 'width: 100%; height: 100%; transform: translate3d(0px, 0px, 0px); content-visibility: visible;');
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');

        const clipId = `gemini-editor-lottie-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const defs = document.createElementNS(svgNs, 'defs');
        const clipPath = document.createElementNS(svgNs, 'clipPath');
        clipPath.setAttribute('id', clipId);
        const clipRect = document.createElementNS(svgNs, 'rect');
        clipRect.setAttribute('width', '28');
        clipRect.setAttribute('height', '28');
        clipRect.setAttribute('x', '0');
        clipRect.setAttribute('y', '0');
        clipPath.appendChild(clipRect);
        defs.appendChild(clipPath);
        svg.appendChild(defs);

        const clippedGroup = document.createElementNS(svgNs, 'g');
        clippedGroup.setAttribute('clip-path', `url(#${clipId})`);

        const dotLayers = getThinkingDotsRenderLayers();
        const dotGroups = [];
        dotLayers.forEach((layer, index) => {
            const dotGroup = document.createElementNS(svgNs, 'g');
            dotGroup.setAttribute('style', 'display: block;');
            dotGroup.setAttribute('opacity', '1');
            dotGroup.setAttribute('data-gemini-editor-dot-index', String(index));
            dotGroup.setAttribute('data-gemini-editor-dot-layer', layer.nm.toLowerCase());

            const innerGroup = document.createElementNS(svgNs, 'g');
            innerGroup.setAttribute('opacity', '1');
            innerGroup.setAttribute('transform', 'matrix(1,0,0,1,0,0)');

            const path = document.createElementNS(svgNs, 'path');
            path.setAttribute('fill', 'rgb(0,0,0)');
            path.setAttribute('fill-opacity', '1');
            path.setAttribute('d', THINKING_DOTS_DOT_PATH);

            innerGroup.appendChild(path);
            dotGroup.appendChild(innerGroup);
            clippedGroup.appendChild(dotGroup);
            dotGroups.push(dotGroup);
        });

        svg.appendChild(clippedGroup);
        wrapper.appendChild(svg);
        root.appendChild(wrapper);
        startThinkingDotsLottieAnimation(root, dotGroups, dotLayers);
        return root;
    }

    function createFallbackPendingAvatar(sourceResponseNode) {
        return createThinkingDotsAnimation(sourceResponseNode);
    }

    function createOptimisticResponseSlot(sourceResponseNode) {
        if (!sourceResponseNode) {
            return null;
        }

        const sourceResponseContainer = sourceResponseNode.querySelector('response-container');
        const sourceInnerContainer = sourceResponseContainer?.querySelector('.response-container') || null;
        const sourceHeader = sourceResponseNode.querySelector('.response-container-header');
        const sourceControls = sourceHeader?.querySelector('.response-container-header-controls') || null;
        const sourceAvatarWrapper = sourceHeader?.querySelector('.response-container-header-avatar') || null;

        const placeholder = document.createElement('pending-response');
        placeholder.className = sourceResponseNode.className || 'ng-star-inserted';
        placeholder.setAttribute('data-gemini-editor-pending-response', 'true');
        copyAngularScopeAttributes(sourceResponseNode, placeholder);

        const responseContainer = cloneResponseShellNode(
            sourceResponseContainer,
            'response-container',
            'ng-star-inserted',
        );
        const innerContainer = cloneResponseShellNode(
            sourceInnerContainer,
            'div',
            'response-container response-container-with-gpi is-mobile',
        );
        if (!innerContainer.classList.contains('response-container')) {
            innerContainer.classList.add('response-container');
        }

        const header = cloneResponseShellNode(
            sourceHeader,
            'div',
            'response-container-header ng-star-inserted',
        );
        const controls = cloneResponseShellNode(
            sourceControls,
            'div',
            'response-container-header-controls',
        );
        const avatarWrapper = cloneResponseShellNode(
            sourceAvatarWrapper,
            'div',
            'response-container-header-avatar ng-star-inserted',
        );

        avatarWrapper.appendChild(createFallbackPendingAvatar(sourceResponseNode));
        header.appendChild(controls);
        header.appendChild(avatarWrapper);
        innerContainer.appendChild(header);
        responseContainer.appendChild(innerContainer);
        placeholder.appendChild(responseContainer);

        stripClonedResponseRuntimeAttributes(placeholder);
        uniquifyClonedSvgIds(placeholder);

        placeholder.style.display = 'block';
        placeholder.style.width = '100%';
        placeholder.style.flex = '1 1 auto';
        placeholder.style.minHeight = '48px';
        return placeholder;
    }

    function setOptimisticQueryText(queryTextElement, text) {
        if (!queryTextElement) {
            return;
        }

        const lineTemplate = queryTextElement.querySelector(SELECTORS.queryTextLine);
        const lineNodes = buildPromptLineNodes(text, () => {
            const paragraph = lineTemplate
                ? lineTemplate.cloneNode(false)
                : document.createElement('p');

            if (!lineTemplate) {
                paragraph.className = 'query-text-line';
            }

            return paragraph;
        });
        const childNodes = Array.from(queryTextElement.childNodes);
        const fragment = document.createDocumentFragment();
        let lineNodesInserted = false;

        childNodes.forEach((node) => {
            const isLineNode = node.nodeType === Node.ELEMENT_NODE
                && node instanceof Element
                && node.matches(SELECTORS.queryTextLine);

            if (isLineNode) {
                if (!lineNodesInserted) {
                    lineNodes.forEach((lineNode) => fragment.appendChild(lineNode));
                    lineNodesInserted = true;
                }
                return;
            }

            fragment.appendChild(node.cloneNode(true));
        });

        if (!lineNodesInserted) {
            lineNodes.forEach((lineNode) => fragment.appendChild(lineNode));
        }

        queryTextElement.replaceChildren(fragment);
    }

    function getAttachmentPreviewDescriptor(node) {
        const fileButton = node?.querySelector?.(SELECTORS.userQueryFileButton);
        if (fileButton) {
            return {
                kind: 'file',
                filename: fileButton.getAttribute('aria-label')?.trim() || '',
                previewUrl: '',
            };
        }

        const imagePreview = node?.querySelector?.(SELECTORS.userQueryImagePreview);
        if (imagePreview) {
            return {
                kind: 'image',
                filename: '',
                previewUrl: normalizeAttachmentMatchUrl(imagePreview.getAttribute('src')),
            };
        }

        const videoPreview = node?.querySelector?.(SELECTORS.userQueryVideoPreview);
        if (videoPreview) {
            return {
                kind: 'video',
                filename: '',
                previewUrl: normalizeAttachmentMatchUrl(videoPreview.getAttribute('src')),
            };
        }

        return {
            kind: '',
            filename: '',
            previewUrl: '',
        };
    }

    function getAttachmentPreviewItemNode(previewNode) {
        const parent = previewNode?.parentElement;
        if (parent?.parentElement?.classList?.contains('scrollable-area')) {
            return parent;
        }

        return previewNode;
    }

    function getUserQueryAttachmentPreviewItems(userQuery) {
        return Array.from(userQuery?.querySelectorAll?.('user-query-file-preview') || [])
            .map((previewNode, index) => {
                return {
                    index,
                    previewNode,
                    itemNode: getAttachmentPreviewItemNode(previewNode),
                    descriptor: getAttachmentPreviewDescriptor(previewNode),
                };
            });
    }

    function selectAttachmentPreviewIndexes(userQuery, attachments) {
        if (!Array.isArray(attachments) || !attachments.length) {
            return new Set();
        }

        const items = getUserQueryAttachmentPreviewItems(userQuery);
        const usedIndexes = new Set();
        const findMatchIndex = (attachment) => {
            const normalizedPreviewUrls = [
                attachment?.previewUrl,
                attachment?.viewUrl,
            ].map(normalizeAttachmentMatchUrl).filter(Boolean);

            if (attachment?.filename) {
                const filenameIndex = items.findIndex((item) => {
                    return !usedIndexes.has(item.index)
                        && item.descriptor.filename
                        && item.descriptor.filename === attachment.filename;
                });
                if (filenameIndex !== -1) {
                    return items[filenameIndex].index;
                }
            }

            if (normalizedPreviewUrls.length) {
                const previewIndex = items.findIndex((item) => {
                    return !usedIndexes.has(item.index)
                        && item.descriptor.previewUrl
                        && normalizedPreviewUrls.includes(item.descriptor.previewUrl);
                });
                if (previewIndex !== -1) {
                    return items[previewIndex].index;
                }
            }

            const kindIndex = items.findIndex((item) => {
                return !usedIndexes.has(item.index)
                    && attachment?.kind
                    && item.descriptor.kind === attachment.kind;
            });
            return kindIndex === -1 ? -1 : items[kindIndex].index;
        };

        attachments.forEach((attachment) => {
            const index = findMatchIndex(attachment);
            if (index !== -1) {
                usedIndexes.add(index);
            }
        });

        return usedIndexes;
    }

    function removeAttachmentPreviewItem(previewNode) {
        const itemNode = getAttachmentPreviewItemNode(previewNode);
        if (itemNode?.parentNode) {
            itemNode.remove();
        } else {
            previewNode.remove();
        }
    }

    function cloneFilteredUserQueryAttachmentContainers(sourceUserQuery, attachments) {
        const selectedIndexes = selectAttachmentPreviewIndexes(sourceUserQuery, attachments);
        if (!selectedIndexes.size) {
            return [];
        }

        let previewIndex = 0;
        return getTopLevelUserQueryAttachmentContainers(sourceUserQuery)
            .map((sourceAttachmentContainer) => {
                const clone = sourceAttachmentContainer.cloneNode(true);
                Array.from(clone.querySelectorAll('user-query-file-preview')).forEach((previewNode) => {
                    if (!selectedIndexes.has(previewIndex)) {
                        removeAttachmentPreviewItem(previewNode);
                    }
                    previewIndex += 1;
                });

                if (!clone.querySelector('user-query-file-preview')) {
                    return null;
                }

                clone.setAttribute(ATTRS.optimisticAttachments, 'true');
                stripClonedAttachmentRuntimeAttributes(clone);
                return clone;
            })
            .filter(Boolean);
    }

    function getUserQueryAttachmentInsertBeforeNode(userQuery) {
        const root = getUserQueryRoot(userQuery);
        if (!root) {
            return { root: null, beforeNode: null };
        }

        const queryContent = Array.from(root.children).find((node) => {
            return node.nodeType === Node.ELEMENT_NODE
                && node instanceof Element
                && node.classList.contains('query-content');
        }) || null;

        return {
            root,
            beforeNode: queryContent || root.firstChild,
        };
    }

    function replaceOptimisticUserQueryAttachmentsFromRecords(targetUserQuery, sourceUserQuery, attachments) {
        if (!targetUserQuery || !sourceUserQuery) {
            return false;
        }

        getTopLevelUserQueryAttachmentContainers(targetUserQuery).forEach((node) => node.remove());

        const clonedContainers = cloneFilteredUserQueryAttachmentContainers(sourceUserQuery, attachments);
        if (!clonedContainers.length) {
            return false;
        }

        const { root, beforeNode } = getUserQueryAttachmentInsertBeforeNode(targetUserQuery);
        if (!root) {
            return false;
        }

        clonedContainers.forEach((container) => {
            root.insertBefore(container, beforeNode);
        });
        return true;
    }

    function appendOptimisticUserQueryAttachmentsFromSource(sourceContainer, targetContainer) {
        const sourceUserQuery = sourceContainer?.querySelector?.(SELECTORS.userQuery);
        const targetUserQuery = targetContainer?.querySelector?.(SELECTORS.userQuery);
        if (!sourceUserQuery || !targetUserQuery) {
            return false;
        }

        const sourceAttachmentContainers = getTopLevelUserQueryAttachmentContainers(sourceUserQuery)
            .filter((node) => {
                return Boolean(node.querySelector([
                    SELECTORS.userQueryFileButton,
                    SELECTORS.userQueryImagePreview,
                    SELECTORS.userQueryVideoPreview,
                ].join(', ')));
            });
        if (!sourceAttachmentContainers.length) {
            return false;
        }

        const { root, beforeNode } = getUserQueryAttachmentInsertBeforeNode(targetUserQuery);
        if (!root) {
            return false;
        }

        sourceAttachmentContainers.forEach((sourceAttachmentContainer) => {
            const clone = sourceAttachmentContainer.cloneNode(true);
            clone.setAttribute(ATTRS.optimisticAttachments, 'true');
            stripClonedAttachmentRuntimeAttributes(clone);
            root.insertBefore(clone, beforeNode);
        });
        return true;
    }

    function createOptimisticConversationContainer(sourceContainer, text, pendingMinHeight, attachments = []) {
        if (!sourceContainer) {
            return null;
        }

        const optimisticContainer = sourceContainer.cloneNode(true);
        optimisticContainer.setAttribute(ATTRS.optimistic, 'true');
        optimisticContainer.removeAttribute('id');
        optimisticContainer.querySelectorAll('[id]').forEach((node) => {
            if (typeof SVGElement === 'undefined' || !(node instanceof SVGElement)) {
                node.removeAttribute('id');
            }
        });
        uniquifyClonedSvgIds(optimisticContainer);

        if (pendingMinHeight) {
            optimisticContainer.style.minHeight = pendingMinHeight;
        }

        const responseNode = optimisticContainer.querySelector(SELECTORS.responseNodes);
        if (responseNode) {
            const responseSlot = createOptimisticResponseSlot(responseNode);
            if (responseSlot) {
                responseNode.replaceWith(responseSlot);
            } else {
                responseNode.remove();
            }
        }

        const queryTextElement = optimisticContainer.querySelector(SELECTORS.queryText);
        setOptimisticQueryText(queryTextElement, text);
        replaceOptimisticUserQueryAttachmentsFromRecords(
            optimisticContainer.querySelector(SELECTORS.userQuery),
            sourceContainer.querySelector(SELECTORS.userQuery),
            attachments,
        );

        return optimisticContainer;
    }

    function moveCaretToEnd(editor) {
        editor.focus();

        const selection = window.getSelection();
        if (!selection) {
            return;
        }

        const range = document.createRange();
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        let lastTextNode = null;

        while (walker.nextNode()) {
            lastTextNode = walker.currentNode;
        }

        if (lastTextNode) {
            range.setStart(lastTextNode, lastTextNode.textContent?.length ?? 0);
        } else if (editor.lastElementChild) {
            range.selectNodeContents(editor.lastElementChild);
        } else {
            range.selectNodeContents(editor);
        }

        range.collapse(false);

        selection.removeAllRanges();
        selection.addRange(range);
    }

    function setDraftText(text) {
        const editor = getEditor();
        if (!editor) {
            return;
        }

        setEditorContent(editor, text ?? '');
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        window.setTimeout(() => moveCaretToEnd(editor), 0);
    }

    function getConversationContainersFrom(container) {
        const containers = getConversationContainers();
        const startIndex = containers.indexOf(container);
        if (startIndex === -1) {
            return [];
        }

        return containers.slice(startIndex);
    }

    function getUserQueryRoot(userQuery) {
        const roots = Array.from(userQuery?.querySelectorAll?.('.user-query-container') || []);
        return roots.find((root) => {
            return Array.from(root.children).some((child) => {
                return child.nodeType === Node.ELEMENT_NODE
                    && child instanceof Element
                    && (
                        child.classList.contains('query-content')
                        || child.classList.contains('file-preview-container')
                    );
            });
        }) || roots[roots.length - 1] || userQuery || null;
    }

    function getTopLevelUserQueryAttachmentContainers(userQuery) {
        const root = getUserQueryRoot(userQuery);
        if (!root) {
            return [];
        }

        return Array.from(root.children).filter((node) => {
            return node.nodeType === Node.ELEMENT_NODE
                && node instanceof Element
                && node.classList.contains('file-preview-container');
        });
    }

    function hasNativeUserQueryAttachmentContainer(userQuery) {
        return getTopLevelUserQueryAttachmentContainers(userQuery).some((node) => {
            return node.getAttribute(ATTRS.optimisticAttachments) !== 'true'
                && Boolean(node.querySelector([
                    SELECTORS.userQueryFileButton,
                    SELECTORS.userQueryImagePreview,
                    SELECTORS.userQueryVideoPreview,
                ].join(', ')));
        });
    }

    function removeOptimisticUserQueryAttachmentContainers(userQuery) {
        getTopLevelUserQueryAttachmentContainers(userQuery)
            .filter((node) => node.getAttribute(ATTRS.optimisticAttachments) === 'true')
            .forEach((node) => node.remove());
    }

    function cleanupOptimisticUserQueryAttachments(userQuery) {
        if (hasNativeUserQueryAttachmentContainer(userQuery)) {
            removeOptimisticUserQueryAttachmentContainers(userQuery);
        }
    }

    function cleanupOptimisticUserQueryAttachmentsInDocument() {
        document.querySelectorAll(SELECTORS.userQuery).forEach((userQuery) => {
            cleanupOptimisticUserQueryAttachments(userQuery);
        });
    }

    function stripClonedAttachmentRuntimeAttributes(root) {
        root.removeAttribute('id');
        root.removeAttribute('jslog');
        root.removeAttribute('aria-describedby');
        root.removeAttribute('cdk-describedby-host');
        root.querySelectorAll('[id], [jslog], [aria-describedby], [cdk-describedby-host]').forEach((node) => {
            node.removeAttribute('id');
            node.removeAttribute('jslog');
            node.removeAttribute('aria-describedby');
            node.removeAttribute('cdk-describedby-host');
        });
    }

    function copyOptimisticUserQueryAttachments(sourceContainer, targetContainer) {
        const sourceUserQuery = sourceContainer?.querySelector?.(SELECTORS.userQuery);
        const targetUserQuery = targetContainer?.querySelector?.(SELECTORS.userQuery);
        if (!sourceUserQuery || !targetUserQuery || hasNativeUserQueryAttachmentContainer(targetUserQuery)) {
            return false;
        }

        const sourceAttachmentContainers = getTopLevelUserQueryAttachmentContainers(sourceUserQuery)
            .filter((node) => {
                return Boolean(node.querySelector([
                    SELECTORS.userQueryFileButton,
                    SELECTORS.userQueryImagePreview,
                    SELECTORS.userQueryVideoPreview,
                ].join(', ')));
            });
        if (!sourceAttachmentContainers.length) {
            return false;
        }

        removeOptimisticUserQueryAttachmentContainers(targetUserQuery);

        const targetRoot = getUserQueryRoot(targetUserQuery);
        if (!targetRoot) {
            return false;
        }

        const queryContent = Array.from(targetRoot.children).find((node) => {
            return node.nodeType === Node.ELEMENT_NODE
                && node instanceof Element
                && node.classList.contains('query-content');
        }) || null;

        sourceAttachmentContainers.forEach((sourceAttachmentContainer) => {
            const clonedAttachmentContainer = sourceAttachmentContainer.cloneNode(true);
            clonedAttachmentContainer.setAttribute(ATTRS.optimisticAttachments, 'true');
            stripClonedAttachmentRuntimeAttributes(clonedAttachmentContainer);
            targetRoot.insertBefore(clonedAttachmentContainer, queryContent || targetRoot.firstChild);
        });
        logDebug('Copied optimistic attachment UI to refreshed message.');
        return true;
    }

    function syncOptimisticConversation() {
        if (!state.optimisticContainer) {
            return;
        }

        if (!state.optimisticContainer.isConnected) {
            state.optimisticContainer = null;
            return;
        }

        let node = state.optimisticContainer.nextElementSibling;
        while (node) {
            if (node.matches?.(SELECTORS.conversationContainer)) {
                if (node.matches?.('pending-request')) {
                    appendOptimisticUserQueryAttachmentsFromSource(node, state.optimisticContainer);
                    node.remove();
                    return;
                }

                promoteAttachmentCarryoverToContainer(node, getConversationContainers().indexOf(node));
                copyOptimisticUserQueryAttachments(state.optimisticContainer, node);
                state.optimisticContainer.remove();
                state.optimisticContainer = null;
                return;
            }

            node = node.nextElementSibling;
        }
    }

    function injectStyles() {
        let style = document.getElementById(STYLE_ID);
        const shouldAppendStyle = !style;
        if (!style) {
            style = document.createElement('style');
            style.id = STYLE_ID;
        }
        style.textContent = `
            .gemini-edit-mode-bar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                width: 100%;
                box-sizing: border-box;
                padding: 10px 24px;
                margin-bottom: 0;
                border-radius: 28px 28px 0 0;
                background-color: var(--gem-sys-color--surface-container-high);
                border: none;
                font-family: "Google Sans", "Helvetica Neue", sans-serif;
                animation: geminiEditSlideIn 0.2s ease;
                z-index: 1;
                position: relative;
                top: 0;
            }

            @keyframes geminiEditSlideIn {
                from {
                    transform: translateY(10px);
                    opacity: 0;
                }
                to {
                    transform: translateY(0);
                    opacity: 1;
                }
            }

            .gemini-input-active-edit input-area-v2 {
                border-top-left-radius: 0 !important;
                border-top-right-radius: 0 !important;
                border-top: none !important;
            }

            .gemini-edit-left {
                display: flex;
                align-items: center;
                gap: 12px;
            }

            .gemini-edit-icon {
                display: flex;
                align-items: center;
                justify-content: center;
                color: var(--gem-sys-color--primary, #a8c7fa);
            }

            .gemini-edit-label {
                font-size: 14px;
                font-weight: 500;
                color: var(--gem-sys-color--on-surface, #e3e3e3);
                letter-spacing: 0.1px;
            }

            .gemini-edit-cancel {
                background: transparent;
                border: 1px solid var(--gem-sys-color--outline, #8e918f);
                color: var(--gem-sys-color--primary, #a8c7fa);
                cursor: pointer;
                font-family: "Google Sans", sans-serif;
                font-weight: 500;
                font-size: 13px;
                padding: 6px 16px;
                border-radius: 100px;
                transition: all 0.2s;
            }

            .gemini-edit-cancel:hover {
                background-color: rgba(var(--gem-sys-color--primary-rgb, 168, 199, 250), 0.08);
                border-color: var(--gem-sys-color--primary, #a8c7fa);
            }

            .gemini-editor-tooltip {
                position: fixed;
                z-index: 2147483647;
                max-width: min(320px, calc(100vw - 16px));
                padding: 6px 8px;
                border-radius: 4px;
                background: rgba(32, 33, 36, 0.96);
                color: #fff;
                font-family: "Google Sans", "Helvetica Neue", sans-serif;
                font-size: 12px;
                font-weight: 500;
                line-height: 16px;
                letter-spacing: 0.1px;
                pointer-events: none;
                opacity: 0;
                transform: translateY(4px);
                transition: opacity 0.12s linear, transform 0.12s ease;
                white-space: nowrap;
            }

            .gemini-editor-tooltip.visible {
                opacity: 1;
                transform: translateY(0);
            }

            .input-area-container [${ATTRS.wrapper}="true"],
            .input-area-container [${ATTRS.customButton}="true"],
            .text-input-field [${ATTRS.wrapper}="true"],
            .text-input-field [${ATTRS.customButton}="true"] {
                display: none !important;
            }

            user-query-content.edit-mode [${ATTRS.wrapper}="true"],
            user-query-content.edit-mode [${ATTRS.customButton}="true"],
            .user-query-container.edit-mode [${ATTRS.wrapper}="true"],
            .user-query-container.edit-mode [${ATTRS.customButton}="true"],
            .query-content.edit-mode [${ATTRS.wrapper}="true"],
            .query-content.edit-mode [${ATTRS.customButton}="true"] {
                display: none !important;
            }

            user-query[${ATTRS.processed}="true"] ${SELECTORS.nativePromptActionHost} {
                display: none !important;
            }

            [data-gemini-editor-pending-response="true"] [data-gemini-editor-loading-dots="true"] {
                display: inline-block;
                width: 28px;
                height: 28px;
                color: var(--gem-sys-color--on-surface, currentColor);
            }

            [data-gemini-editor-pending-response="true"] [data-gemini-editor-loading-dots="true"] .thinking-dots-animation {
                width: var(--gem-sys-spacing--xxl, 28px);
                height: var(--gem-sys-spacing--xxl, 28px);
            }

            [data-gemini-editor-pending-response="true"] [data-gemini-editor-loading-dots="true"] svg {
                width: 100%;
                height: 100%;
                display: block;
            }

            [data-gemini-editor-pending-response="true"] [data-gemini-editor-loading-dots="true"] svg path {
                fill: var(--gem-sys-color--on-surface, currentColor);
                stroke: var(--gem-sys-color--on-surface, currentColor);
            }

            [data-gemini-editor-pending-response="true"] .avatar_primary_animation {
                transform-origin: center;
                animation: geminiEditorPendingAvatarPulse 1.35s ease-in-out infinite;
            }

            [data-gemini-editor-pending-response="true"] .avatar_primary_animation svg {
                transform-origin: center;
                animation: geminiEditorPendingAvatarTurn 1.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
            }

            [data-gemini-editor-pending-response="true"] .avatar_primary_animation svg g[mask] {
                transform-origin: center;
                animation: geminiEditorPendingAvatarSweep 1.35s ease-in-out infinite;
            }

            @keyframes geminiEditorPendingAvatarPulse {
                0%, 100% {
                    opacity: 0.72;
                    filter: saturate(0.95);
                }
                45% {
                    opacity: 1;
                    filter: saturate(1.25);
                }
            }

            @keyframes geminiEditorPendingAvatarTurn {
                0% {
                    transform: rotate(0deg) scale(0.92);
                }
                45% {
                    transform: rotate(90deg) scale(1.04);
                }
                100% {
                    transform: rotate(180deg) scale(0.92);
                }
            }

            @keyframes geminiEditorPendingAvatarSweep {
                0%, 100% {
                    opacity: 0.68;
                }
                50% {
                    opacity: 1;
                }
            }

            .text-input-field .attachment-preview-wrapper[${ATTRS.attachmentOwned}="true"] {
                grid-area: file-preview;
                display: flex;
                gap: var(--gem-sys-spacing--s);
                flex-wrap: nowrap;
                overflow-x: auto;
                max-height: 168px;
                margin-inline: 0;
                width: 100%;
                align-self: stretch;
            }

            .text-input-field:has(.attachment-preview-wrapper[${ATTRS.attachmentOwned}="true"]) {
                row-gap: var(--gem-sys-spacing--s);
            }

            .attachment-preview-wrapper[${ATTRS.attachmentOwned}="true"] > uploader-file-preview-container[${ATTRS.attachmentOwned}="true"] {
                display: contents;
            }

            uploader-file-preview-container[${ATTRS.attachmentOwned}="true"] {
                display: inline-flex;
                flex-flow: nowrap;
                overflow: auto;
                width: auto;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] {
                flex-shrink: 0;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .file-preview-container {
                padding: 0;
                position: relative;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .gem-attachment-tile {
                display: flex;
                width: 112px;
                height: 112px;
                position: relative;
                color: var(--gem-sys-color--on-surface, #1f1f1f);
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] mat-basic-chip {
                display: block;
                width: 100%;
                height: 100%;
                position: relative;
                overflow: hidden;
                box-sizing: border-box;
                border-radius: var(--gem-sys-shape--corner-large-increased, 18px);
                background-color: var(--bard-color-lm-on-surface-low, var(--gem-sys-color--surface-container, #f0f4f9));
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .mdc-evolution-chip__cell,
            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .mdc-evolution-chip__action,
            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .mdc-evolution-chip__text-label {
                display: block;
                width: 100%;
                height: 100%;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .mat-mdc-chip-focus-overlay,
            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .mat-mdc-chip-primary-focus-indicator {
                display: none;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .gem-attachment-content {
                position: absolute;
                inset: var(--gem-sys-spacing--s, 8px);
                z-index: 1;
                display: flex;
                flex-direction: column;
                justify-content: flex-end;
                pointer-events: none;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .gem-attachment-icon {
                position: absolute;
                top: 0;
                inset-inline-start: 0;
                display: flex;
                width: 24px;
                height: 24px;
                align-items: center;
                justify-content: center;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .gem-attachment-icon img,
            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .gem-attachment-icon .lm-icon-l {
                width: 24px;
                height: 24px;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .gem-attachment-text {
                display: -webkit-box;
                width: 100%;
                max-height: 60px;
                overflow: hidden;
                color: var(--gem-sys-color--on-surface, #1f1f1f);
                font-family: "Google Sans Flex", "Google Sans", "Helvetica Neue", sans-serif;
                font-size: 14px;
                line-height: 20px;
                white-space: pre-wrap;
                overflow-wrap: anywhere;
                text-overflow: ellipsis;
                -webkit-box-orient: vertical;
                -webkit-line-clamp: 3;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .gem-attachment-style-img {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                object-fit: cover;
                z-index: 0;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .time-overlay {
                display: flex;
                align-items: center;
                gap: 2px;
                width: fit-content;
                max-width: calc(100% - 28px);
                color: #000;
                background-color: #fff;
                border-radius: var(--gem-sys-shape--corner-full, 999px);
                padding: 2px 6px 2px 4px;
                font-family: "Google Sans", "Helvetica Neue", sans-serif;
                font-size: 12px;
                line-height: 16px;
                pointer-events: none;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .time-overlay mat-icon {
                width: 16px;
                height: 16px;
                font-size: 16px;
                color: #000;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .gem-attachment-close-button {
                position: absolute;
                top: 4px;
                inset-inline-end: 4px;
                z-index: 3;
                width: 24px;
                height: 24px;
                border-radius: 50%;
                background-color: #fff;
                visibility: hidden;
                pointer-events: auto;
                overflow: hidden;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .gem-attachment-tile:hover .gem-attachment-close-button,
            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .gem-attachment-tile:focus-within .gem-attachment-close-button {
                visibility: visible;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .gem-attachment-close-button button {
                display: flex;
                width: 24px;
                height: 24px;
                min-width: 24px;
                padding: 0;
                align-items: center;
                justify-content: center;
                border: 0;
                border-radius: 50%;
                background: transparent;
                color: #000;
                cursor: pointer;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .gem-attachment-close-button mat-icon {
                display: block;
                width: 18px;
                height: 18px;
                font-size: 18px;
                line-height: 18px;
                color: #000;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .file-preview,
            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .image-preview {
                position: relative;
                border-radius: var(--gem-sys-shape--corner-large);
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .file-preview.discovery-feed-theme {
                background: var(--gem-sys-color--surface-container-high);
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .file-preview {
                width: 208px;
                height: unset;
                padding: var(--gem-sys-spacing--l) 44px var(--gem-sys-spacing--l) var(--gem-sys-spacing--l);
                display: grid;
                grid-template:
                    "name name" 1fr
                    "icon type" var(--gem-sys-spacing--xl)
                    / var(--gem-sys-spacing--xl) 1fr;
                gap: var(--gem-sys-spacing--s) var(--gem-sys-spacing--xs);
                align-items: center;
                box-sizing: border-box;
                text-align: start;
                border-radius: var(--gem-sys-shape--corner-large-increased);
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .file-icon,
            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .file-name,
            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .file-type {
                margin: 0;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .file-name {
                grid-area: name;
                color: var(--gem-sys-color--on-surface-variant);
                font-family: "Google Sans Flex", "Google Sans", "Helvetica Neue", sans-serif;
                font-size: var(--gem-sys-typography-type-scale--title-s-font-size);
                font-weight: var(--gem-sys-typography-type-scale--title-s-font-weight);
                letter-spacing: var(--gem-sys-typography-type-scale--title-s-font-tracking);
                line-height: var(--gem-sys-typography-type-scale--title-s-line-height);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .file-icon {
                grid-area: icon;
                place-self: center;
                width: var(--gem-sys-spacing--l);
                height: var(--gem-sys-spacing--l);
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .file-type {
                grid-area: type;
                color: var(--gem-sys-color--on-surface-variant);
                font-family: "Google Sans Flex", "Google Sans", "Helvetica Neue", sans-serif;
                font-size: var(--gem-sys-typography-type-scale--label-m-font-size);
                font-weight: var(--gem-sys-typography-type-scale--label-m-font-weight);
                letter-spacing: var(--gem-sys-typography-type-scale--label-m-font-tracking);
                line-height: var(--gem-sys-typography-type-scale--label-m-line-height);
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .image-preview {
                width: 80px;
                height: 80px;
                overflow: hidden;
                display: flex;
                justify-content: center;
                align-items: center;
                background: var(--gem-sys-color--surface-container-highest);
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] button.image-preview {
                background: none;
                border: none;
                margin: 0;
                padding: 0;
                text-decoration: underline;
                cursor: pointer;
                color: var(--gem-sys-color--primary);
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .image-preview > img {
                width: 100%;
                height: 100%;
                object-fit: cover;
                border-radius: 0;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .video-preview-img-container {
                position: relative;
                display: inline-block;
                width: 100%;
                height: 100%;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .video-preview-img-container::before {
                content: "";
                position: absolute;
                inset: 0;
                background: linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.6));
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .video-preview-img-container img {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .timecode-wrapper {
                padding: var(--gem-sys-spacing--s);
                position: absolute;
                inset-inline-start: 0;
                bottom: 0;
                display: flex;
                height: var(--gem-sys-spacing--l);
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .timecode-wrapper .video-timecode {
                color: #fff;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .cancel-button {
                width: unset;
                height: unset;
                padding: var(--gem-sys-spacing--s);
                box-sizing: border-box;
                position: absolute;
                top: 0;
                right: 0;
                background: transparent;
                border: none;
                cursor: pointer;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .cancel-button > .mat-icon {
                display: none;
                position: relative;
                align-items: center;
                justify-content: center;
                font-size: var(--gem-sys-spacing--xxl);
                width: var(--gem-sys-spacing--xxl);
                height: var(--gem-sys-spacing--xxl);
                padding: var(--gem-sys-spacing--xs);
                color: var(--gem-sys-color--on-surface-variant);
                background-color: var(--gem-sys-color--surface);
                border-radius: 50%;
                opacity: 1;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .cancel-button > .mat-icon::after {
                content: "";
                position: absolute;
                inset: 0;
                border-radius: 50%;
                background-color: var(--gem-sys-color--on-surface-variant);
                opacity: 0;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .cancel-button:hover > .mat-icon::after {
                opacity: 0.08;
            }

            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .file-preview:hover .cancel-button > .mat-icon,
            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .image-preview:hover .cancel-button > .mat-icon,
            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .file-preview-container:hover > .image-preview + .cancel-button > .mat-icon,
            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .file-preview-container:hover > button.image-preview + .cancel-button > .mat-icon,
            uploader-file-preview[${ATTRS.attachmentOwned}="true"] .file-preview-container:focus-within > button.image-preview + .cancel-button > .mat-icon {
                display: flex;
                background-color: var(--gem-sys-color--surface);
            }
        `;

        const target = document.head || document.documentElement;
        if (target && shouldAppendStyle) {
            target.appendChild(style);
        }
    }

    function getClickableButtonFromActionNode(node) {
        if (!node) {
            return null;
        }

        if (node.matches?.('button')) {
            return node;
        }

        return node.querySelector?.('button') || null;
    }

    function getPromptActionHost(button) {
        if (!button) {
            return null;
        }

        const componentHost = button.closest?.('gem-icon-button, gem-button');
        if (componentHost) {
            return componentHost;
        }

        const dataTestHost = button.closest?.('[data-test-id="prompt-copy-button"], [data-test-id="prompt-edit-button"]');
        if (dataTestHost && dataTestHost !== button) {
            return dataTestHost;
        }

        return button.parentElement || button;
    }

    function createEditButtonElement(copyButton) {
        const strings = getUiStrings();
        const sourceHost = getPromptActionHost(copyButton);
        const container = sourceHost
            ? sourceHost.cloneNode(false)
            : document.createElement('gem-icon-button');

        if (!sourceHost) {
            container.className = 'luminous-action-button gem-button gem-button-badge-size-small gem-button-size-small gem-button-type-translucent lm-enabled ng-star-inserted';
        }

        container.setAttribute(ATTRS.wrapper, 'true');
        container.setAttribute(ATTRS.tooltip, strings.editTooltip);
        container.setAttribute('arialabel', strings.editLabel);
        container.setAttribute('gemtooltip', strings.editTooltip);
        container.removeAttribute('data-test-id');
        container.removeAttribute('aria-describedby');
        container.removeAttribute('cdk-describedby-host');
        container.removeAttribute('jslog');

        const button = copyButton ? copyButton.cloneNode(true) : document.createElement('button');

        button.setAttribute('type', 'button');
        button.setAttribute('aria-label', strings.editLabel);
        button.setAttribute('data-gemini-editor-role', 'edit-button');
        button.setAttribute(ATTRS.customButton, 'true');
        button.setAttribute(ATTRS.tooltip, strings.editTooltip);
        button.disabled = false;
        button.removeAttribute('disabled');
        button.removeAttribute('aria-disabled');
        button.removeAttribute('aria-describedby');
        button.removeAttribute('aria-controls');
        button.removeAttribute('cdk-describedby-host');
        button.removeAttribute('data-test-id');
        button.removeAttribute('jslog');
        button.removeAttribute('mattooltip');

        const icon = button.querySelector('mat-icon');
        if (icon) {
            icon.setAttribute('fonticon', 'edit');
            icon.setAttribute('data-mat-icon-name', 'edit');
            icon.textContent = '';
        }

        ensureButtonRippleSpan(button);

        container.appendChild(button);
        return { container, button };
    }

    function getResponseJslogNode(container) {
        const selectors = [
            'model-response [jslog]',
            'pending-response [jslog]',
            'dual-model-response [jslog]',
            'generative-ui-response [jslog]',
        ];

        for (const selector of selectors) {
            const node = container.querySelector(selector);
            if (node) {
                return node;
            }
        }

        return null;
    }

    function getParentData(currentContainer, index, allContainers) {
        const parentData = { r: null, c: null, rc: null };

        if (index > 0) {
            const previousContainer = allContainers[index - 1];
            const previousUserQuery = previousContainer.querySelector(SELECTORS.userQuery);
            const previousModelNode = getResponseJslogNode(previousContainer);

            const userData = getBestJslogData(previousUserQuery);
            const modelData = getBestJslogData(previousModelNode);

            let rc = modelData?.rc ?? null;
            if (!rc) {
                const draftNode = previousContainer.querySelector(SELECTORS.draftNode);
                rc = draftNode?.getAttribute('data-test-draft-id') ?? null;
            }

            parentData.r = userData?.r || modelData?.r || null;
            parentData.c = userData?.c || modelData?.c || null;
            parentData.rc = rc;
            return parentData;
        }

        const currentUserQuery = currentContainer.querySelector(SELECTORS.userQuery);
        const currentData = getBestJslogData(currentUserQuery);
        parentData.c = currentData?.c || getConversationIdFromLocation();
        return parentData;
    }

    function ensureEditModeBanner() {
        const strings = getUiStrings();
        const inputAreaContainer = document.querySelector(SELECTORS.inputAreaContainer);
        if (!inputAreaContainer) {
            return;
        }

        inputAreaContainer.classList.add('gemini-input-active-edit');

        if (document.querySelector(SELECTORS.editModeBar)) {
            return;
        }

        const banner = document.createElement('div');
        banner.className = 'gemini-edit-mode-bar';

        const left = document.createElement('div');
        left.className = 'gemini-edit-left';

        const iconWrapper = document.createElement('div');
        iconWrapper.className = 'gemini-edit-icon';

        const svgNs = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('width', '20');
        svg.setAttribute('height', '20');
        svg.setAttribute('viewBox', '0 -960 960 960');
        svg.setAttribute('fill', 'currentColor');

        const path = document.createElementNS(svgNs, 'path');
        path.setAttribute('d', 'M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 17l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z');
        svg.appendChild(path);
        iconWrapper.appendChild(svg);

        const label = document.createElement('span');
        label.className = 'gemini-edit-label';
        label.textContent = strings.editMode;

        const cancelButton = document.createElement('button');
        cancelButton.className = 'gemini-edit-cancel';
        cancelButton.type = 'button';
        cancelButton.textContent = strings.cancel;
        cancelButton.addEventListener('click', disableEditMode);

        left.appendChild(iconWrapper);
        left.appendChild(label);
        banner.appendChild(left);
        banner.appendChild(cancelButton);

        inputAreaContainer.prepend(banner);
    }

    function enableEditMode(text, parentData, targetContainer, attachments) {
        state.editTargetContainer = targetContainer;
        state.editContextPath = getCurrentChatLocationKey();
        state.pendingOverride = {
            ...parentData,
            attachments: Array.isArray(attachments)
                ? attachments.map(cloneAttachmentRecord).filter(Boolean)
                : [],
        };
        logDebug('Edit mode enabled.', {
            text,
            parentData,
            attachmentCount: state.pendingOverride.attachments.length,
            path: state.editContextPath,
        });

        setDraftText(text);
        clearNativeComposerAttachments();
        ensureEditModeBanner();
        syncEditComposerAttachmentUi();
    }

    function disableEditMode() {
        logDebug('Edit mode disabled.');
        state.editTargetContainer = null;
        state.editContextPath = null;
        state.pendingOverride = null;

        const banner = document.querySelector(SELECTORS.editModeBar);
        if (banner) {
            banner.remove();
        }

        const inputAreaContainer = document.querySelector(SELECTORS.inputAreaContainer);
        if (inputAreaContainer) {
            inputAreaContainer.classList.remove('gemini-input-active-edit');
        }

        removeOwnedAttachmentUi();
        clearNativeComposerAttachments();
        setDraftText('');
    }

    function syncEditModeWithCurrentChat() {
        if (!state.editTargetContainer) {
            return;
        }

        if (state.editContextPath !== getCurrentChatLocationKey() || !state.editTargetContainer.isConnected) {
            disableEditMode();
        }
    }

    function clearHistoryFrom(container) {
        getConversationContainersFrom(container).forEach((node) => node.remove());
    }

    function getPendingOverrideAttachmentRecords() {
        return Array.isArray(state.pendingOverride?.attachments)
            ? state.pendingOverride.attachments.map(cloneAttachmentRecord).filter(Boolean)
            : [];
    }

    function beginOptimisticEditUi(targetContainer, submittedText, attachments = getPendingOverrideAttachmentRecords()) {
        if (state.optimisticContainer?.isConnected) {
            return true;
        }

        if (!targetContainer?.parentElement) {
            return false;
        }

        const pendingMinHeight = getOptimisticConversationMinHeight(targetContainer);
        const optimisticContainer = createOptimisticConversationContainer(
            targetContainer,
            submittedText,
            pendingMinHeight,
            attachments,
        );
        if (!optimisticContainer) {
            return false;
        }

        targetContainer.parentElement.insertBefore(optimisticContainer, targetContainer);
        state.optimisticContainer = optimisticContainer;
        clearHistoryFrom(targetContainer);
        return true;
    }

    function handleOverrideSuccess(targetContainer, submittedText, attachments = getPendingOverrideAttachmentRecords()) {
        logDebug('Applying optimistic edit UI.', {
            submittedText,
            hasTarget: Boolean(targetContainer),
        });
        disableEditMode();

        if (state.optimisticContainer?.isConnected) {
            return;
        }

        state.optimisticContainer = null;
        beginOptimisticEditUi(targetContainer, submittedText, attachments);
    }

    function handlePendingEditSubmitIntent() {
        if (!state.pendingOverride || !state.editTargetContainer) {
            return;
        }

        beginOptimisticEditUi(state.editTargetContainer, getEditorText(), getPendingOverrideAttachmentRecords());
    }

    function getPendingRequestText(pendingRequest) {
        return getPlainTextFromElement(pendingRequest?.querySelector(SELECTORS.queryText))
            || getEditorText();
    }

    function syncPendingEditRequest() {
        if (
            !state.pendingOverride
            || !state.editTargetContainer
            || state.optimisticContainer?.isConnected
        ) {
            return false;
        }

        const pendingRequest = document.querySelector('pending-request');
        if (!pendingRequest) {
            return false;
        }

        beginOptimisticEditUi(state.editTargetContainer, getPendingRequestText(pendingRequest), getPendingOverrideAttachmentRecords());
        if (pendingRequest.isConnected) {
            pendingRequest.remove();
        }

        return true;
    }

    function handleEditClick(userQuery) {
        const currentContainer = userQuery.closest(SELECTORS.conversationContainer);
        if (!currentContainer) {
            logDebug('Edit click ignored: no conversation container.');
            return;
        }

        const allContainers = getConversationContainers();
        const index = allContainers.indexOf(currentContainer);
        if (index === -1) {
            return;
        }

        const textElement = userQuery.querySelector(SELECTORS.queryText);
        const text = getPlainTextFromElement(textElement);
        const parentData = getParentData(currentContainer, index, allContainers);
        const currentData = mergeJslogData(
            getBestJslogData(userQuery),
            getBestJslogData(currentContainer),
        );
        let cachedAttachments = getCachedAttachmentsForMessage(
            currentData?.c || getConversationIdFromLocation(),
            currentData?.r,
        );
        if (!cachedAttachments.length && promoteAttachmentCarryoverToContainer(currentContainer, index)) {
            cachedAttachments = getCachedAttachmentsForMessage(
                currentData?.c || getConversationIdFromLocation(),
                currentData?.r,
            );
        }

        const carryoverAttachments = !cachedAttachments.length
            ? getAttachmentCarryoverForContainer(currentContainer, index)
            : [];
        const sourceAttachments = cachedAttachments.length ? cachedAttachments : carryoverAttachments;
        let attachments = filterCachedAttachmentsByUserQueryUi(sourceAttachments, userQuery);
        if (!attachments.length) {
            attachments = findCachedAttachmentsByUserQueryUi(
                currentData?.c || getConversationIdFromLocation(),
                userQuery,
            );
        }
        const fallbackUiAttachments = !attachments.length
            ? createFallbackAttachmentRecordsFromUserQueryUi(userQuery)
            : [];
        if (fallbackUiAttachments.length) {
            attachments = fallbackUiAttachments;
        }
        logDebug('Opening edit mode.', {
            index,
            text,
            parentData,
            messageId: currentData?.r ?? null,
            cachedAttachmentCount: cachedAttachments.length,
            carryoverAttachmentCount: carryoverAttachments.length,
            fallbackAttachmentCount: fallbackUiAttachments.length,
            attachmentCount: attachments.length,
        });

        enableEditMode(text, parentData, currentContainer, attachments);
    }

    function isLastConversationContainer(container) {
        const containers = getConversationContainers();
        return Boolean(container && containers[containers.length - 1] === container);
    }

    function getNativeEditButton(userQuery) {
        const nativeButton = Array.from(userQuery.querySelectorAll(SELECTORS.nativeEditButton))
            .map(getClickableButtonFromActionNode)
            .find((button) => {
                return button
                    && button.getAttribute(ATTRS.customButton) !== 'true'
                    && !button.closest?.(`[${ATTRS.wrapper}="true"]`);
            });
        if (nativeButton) {
            return nativeButton;
        }

        return Array.from(userQuery.querySelectorAll(SELECTORS.nativeEditIcon))
            .map((icon) => icon.closest('button'))
            .find((button) => {
                return button
                    && button.getAttribute(ATTRS.customButton) !== 'true'
                    && !button.closest?.(`[${ATTRS.wrapper}="true"]`);
            }) || null;
    }

    function hideNativeEditButton(nativeEditButton) {
        const wrapper = getPromptActionHost(nativeEditButton);
        if (wrapper && wrapper.getAttribute(ATTRS.wrapper) !== 'true') {
            wrapper.style.display = 'none';
        }
    }

    function isNativeEditModeContainer(container) {
        return Boolean(container?.querySelector?.([
            '.edit-button-area button.cancel-button',
            '.edit-button-area button.update-button',
            '.edit-button-area gem-button.cancel-button',
            '.edit-button-area gem-button.update-button',
            '.user-query-container.edit-mode',
            '.query-content.edit-mode',
        ].join(', ')));
    }

    function removeCustomEditButtons(root) {
        if (!root?.querySelectorAll) {
            return;
        }

        root.querySelectorAll(`[${ATTRS.wrapper}="true"]`).forEach((node) => {
            node.remove();
        });

        root.querySelectorAll(`[${ATTRS.customButton}="true"]`).forEach((button) => {
            const wrapper = button.closest(`[${ATTRS.wrapper}="true"]`);
            if (wrapper) {
                wrapper.remove();
            } else {
                button.remove();
            }
        });
    }

    function cleanupMisplacedCustomEditButtons() {
        document.querySelectorAll([
            SELECTORS.inputAreaContainer,
            SELECTORS.textInputField,
        ].join(', ')).forEach(removeCustomEditButtons);

        getConversationContainers().forEach((container) => {
            if (isNativeEditModeContainer(container)) {
                removeCustomEditButtons(container);
            }
        });
    }

    function getCustomEditButtonWrappers(userQuery) {
        const wrappers = Array.from(userQuery.querySelectorAll(`[${ATTRS.wrapper}="true"]`));
        const orphanButtons = Array.from(userQuery.querySelectorAll(`[${ATTRS.customButton}="true"]`))
            .filter((button) => !button.closest(`[${ATTRS.wrapper}="true"]`));

        return {
            wrappers,
            orphanButtons,
            count: wrappers.length + orphanButtons.length,
        };
    }

    function hasStableCustomEditButton(userQuery, buttonsContainer) {
        const custom = getCustomEditButtonWrappers(userQuery);
        return custom.count === 1
            && custom.wrappers.length === 1
            && custom.wrappers[0].parentElement === buttonsContainer
            && Boolean(custom.wrappers[0].querySelector(`[${ATTRS.customButton}="true"]`));
    }

    function triggerNativeEditMode(userQuery, nativeEditButton, customButtonContainer) {
        if (!nativeEditButton) {
            return false;
        }

        const currentContainer = userQuery.closest(SELECTORS.conversationContainer);
        const wrapper = getPromptActionHost(nativeEditButton);
        const previousDisplay = wrapper?.style?.display;
        customButtonContainer?.remove();
        removeCustomEditButtons(currentContainer);
        if (wrapper) {
            wrapper.style.display = '';
        }

        const hadScriptEditMode = Boolean(state.pendingOverride || state.editTargetContainer);
        nativeEditButton.click();

        if (wrapper) {
            wrapper.style.display = previousDisplay || 'none';
        }

        cleanupMisplacedCustomEditButtons();
        window.requestAnimationFrame(cleanupMisplacedCustomEditButtons);
        window.setTimeout(cleanupMisplacedCustomEditButtons, 100);
        window.setTimeout(cleanupMisplacedCustomEditButtons, 300);
        window.setTimeout(() => {
            cleanupMisplacedCustomEditButtons();
            if (!isNativeEditModeContainer(currentContainer)) {
                processUserQuery(userQuery);
            }
        }, 1500);

        if (hadScriptEditMode) {
            disableEditMode();
        }
        return true;
    }

    function canUseNativeEditMode(currentContainer, nativeEditButton) {
        return Boolean(nativeEditButton && isLastConversationContainer(currentContainer));
    }

    function processUserQuery(userQuery) {
        if (!userQuery) {
            return;
        }

        const currentContainer = userQuery.closest(SELECTORS.conversationContainer);
        if (isNativeEditModeContainer(currentContainer)) {
            removeCustomEditButtons(currentContainer);
            return;
        }

        const nativeEditButton = getNativeEditButton(userQuery);

        const copyIcon = userQuery.querySelector(SELECTORS.copyIcon);
        if (!copyIcon) {
            return;
        }

        const copyButton = copyIcon.closest('button');
        const copyWrapper = getPromptActionHost(copyButton);
        const buttonsContainer = copyWrapper?.parentElement;
        if (!copyButton || !copyWrapper || !buttonsContainer) {
            return;
        }

        if (hasStableCustomEditButton(userQuery, buttonsContainer)) {
            userQuery.setAttribute(ATTRS.processed, 'true');
            hideNativeEditButton(nativeEditButton);
            return;
        }

        removeCustomEditButtons(userQuery);

        const { container, button } = createEditButtonElement(copyButton);

        if (nativeEditButton) {
            const nativeWrapper = getPromptActionHost(nativeEditButton);
            if (nativeWrapper && nativeWrapper.parentElement === buttonsContainer) {
                nativeWrapper.style.display = 'none';
                buttonsContainer.insertBefore(container, nativeWrapper);
            } else if (copyWrapper.nextSibling) {
                buttonsContainer.insertBefore(container, copyWrapper.nextSibling);
            } else {
                buttonsContainer.appendChild(container);
            }
        } else if (copyWrapper.nextSibling) {
            buttonsContainer.insertBefore(container, copyWrapper.nextSibling);
        } else {
            buttonsContainer.appendChild(container);
        }

        userQuery.setAttribute(ATTRS.processed, 'true');
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();

            if (event.ctrlKey && canUseNativeEditMode(currentContainer, nativeEditButton)) {
                triggerNativeEditMode(userQuery, nativeEditButton, container);
                return;
            }

            logDebug('Custom edit button clicked.', {
                text: userQuery.querySelector(SELECTORS.queryText)?.innerText ?? null,
            });
            handleEditClick(userQuery);
        });
    }

    function scanConversationContainers() {
        injectStyles();
        ensureComposerButtonRipples();
        cleanupMisplacedCustomEditButtons();
        syncAttachmentCacheScope();
        syncEditModeWithCurrentChat();
        syncOptimisticConversation();

        const containers = getConversationContainers();
        containers.forEach((container) => {
            const userQuery = container.querySelector(SELECTORS.userQuery);
            if (userQuery) {
                cleanupOptimisticUserQueryAttachments(userQuery);
                processUserQuery(userQuery);
            }
        });

        if (getAttachmentCarryover() && !state.optimisticContainer) {
            for (const [index, container] of containers.entries()) {
                if (promoteAttachmentCarryoverToContainer(container, index)) {
                    break;
                }
            }
        }

        if (state.pendingOverride) {
            ensureEditModeBanner();
        }

        syncEditComposerAttachmentUi();
    }

    function scheduleScan() {
        if (state.scanQueued) {
            return;
        }

        state.scanQueued = true;
        const schedule = window.requestAnimationFrame
            ? window.requestAnimationFrame.bind(window)
            : (callback) => window.setTimeout(callback, 16);

        schedule(() => {
            state.scanQueued = false;
            scanConversationContainers();
        });
    }

    function attachObserver() {
        if (state.observer) {
            return;
        }

        const observerTarget = getAppMain();
        if (!observerTarget) {
            return;
        }

        state.observer = new MutationObserver(() => {
            syncPendingEditRequest();
            syncOptimisticConversation();
            cleanupOptimisticUserQueryAttachmentsInDocument();
            scheduleScan();
        });

        state.observer.observe(observerTarget, {
            childList: true,
            subtree: true,
        });
    }

    function isEnabledSendButton(button) {
        const innerButton = button?.matches?.('button') ? button : button?.querySelector?.('button');
        return button
            && !button.disabled
            && !innerButton?.disabled
            && button.getAttribute('aria-disabled') !== 'true'
            && innerButton?.getAttribute?.('aria-disabled') !== 'true';
    }

    function handleSubmitIntentCapture(event) {
        if (!state.pendingOverride) {
            return;
        }

        const sendButton = event.target?.closest?.(SELECTORS.sendButton);
        if (isEnabledSendButton(sendButton)) {
            handlePendingEditSubmitIntent();
        }
    }

    function handleEditorSubmitKeyCapture(event) {
        if (
            !state.pendingOverride
            || event.defaultPrevented
            || event.isComposing
            || event.key !== 'Enter'
            || event.shiftKey
            || event.altKey
            || event.ctrlKey
            || event.metaKey
            || !event.target?.closest?.(SELECTORS.editor)
        ) {
            return;
        }

        handlePendingEditSubmitIntent();
    }

    function patchHistoryNavigation() {
        if (window.history.pushState.__geminiEditorPatched || window.history.replaceState.__geminiEditorPatched) {
            return;
        }

        const originalPushState = window.history.pushState;
        const originalReplaceState = window.history.replaceState;

        window.history.pushState = function pushState() {
            const result = originalPushState.apply(this, arguments);
            window.setTimeout(scheduleScan, 0);
            return result;
        };

        window.history.replaceState = function replaceState() {
            const result = originalReplaceState.apply(this, arguments);
            window.setTimeout(scheduleScan, 0);
            return result;
        };

        window.history.pushState.__geminiEditorPatched = true;
        window.history.replaceState.__geminiEditorPatched = true;
    }

    function startUiController() {
        if (state.uiStarted) {
            return;
        }

        state.uiStarted = true;
        injectStyles();
        initTooltipController();
        scheduleScan();
        attachObserver();
        patchHistoryNavigation();

        window.addEventListener('pageshow', scheduleScan);
        window.addEventListener('popstate', scheduleScan);
        document.addEventListener('DOMContentLoaded', () => {
            attachObserver();
            scheduleScan();
        }, { once: true });
        document.addEventListener('click', handleSubmitIntentCapture, true);
        document.addEventListener('keydown', handleEditorSubmitKeyCapture, true);
    }

    function isGeminiGenerateRequest(url) {
        return typeof url === 'string' && url.includes('StreamGenerate');
    }

    function isBatchExecuteRequest(url) {
        return typeof url === 'string' && url.includes('/_/BardChatUi/data/batchexecute');
    }

    function maybeCaptureConversationLoad(rawText) {
        const captured = handleConversationLoadResponse(rawText);
        if (captured) {
            logDebug('Captured conversation-load payload.', {
                cachedMessages: state.attachmentCache.size,
            });
        }

        return captured;
    }

    function maybeCaptureStreamGenerate(rawText) {
        const captured = handleStreamGenerateResponse(rawText);
        if (captured) {
            logDebug('Captured StreamGenerate attachments.', {
                cachedMessages: state.attachmentCache.size,
            });
            window.setTimeout(scheduleScan, 0);
        }

        return captured;
    }

    function getRequestBodyText(body) {
        if (typeof body === 'string') {
            return body;
        }

        if (body instanceof URLSearchParams) {
            return body.toString();
        }

        return '';
    }

    function parseStreamGenerateRequestBody(body) {
        const bodyText = getRequestBodyText(body);
        if (!bodyText) {
            return null;
        }

        try {
            const params = new URLSearchParams(bodyText);
            const requestPayload = params.get('f.req');
            if (!requestPayload) {
                return null;
            }

            const outerPayload = JSON.parse(requestPayload);
            if (!Array.isArray(outerPayload) || typeof outerPayload[1] !== 'string') {
                return null;
            }

            const innerPayload = JSON.parse(outerPayload[1]);
            return Array.isArray(innerPayload) ? innerPayload : null;
        } catch (error) {
            logDebugIssue('Failed to parse StreamGenerate request body.', error);
            return null;
        }
    }

    function getTextFromStreamGenerateRequestPayload(innerPayload) {
        return typeof innerPayload?.[0]?.[0] === 'string' ? innerPayload[0][0] : '';
    }

    function getConversationIdFromStreamGenerateRequestPayload(innerPayload) {
        const conversationId = innerPayload?.[2]?.[0];
        return isConversationId(conversationId) ? conversationId : getConversationIdFromLocation();
    }

    function maybeCaptureOutgoingStreamGenerate(body, meta = {}) {
        const innerPayload = parseStreamGenerateRequestBody(body);
        const nativeAttachments = Array.isArray(innerPayload?.[0]?.[3]) ? innerPayload[0][3] : [];
        if (!nativeAttachments.length) {
            return false;
        }

        const attachments = normalizeNativePayloadAttachments(nativeAttachments, getTextInputField());
        if (!attachments.length) {
            return false;
        }

        const submittedText = meta.submittedText || getTextFromStreamGenerateRequestPayload(innerPayload);
        setAttachmentCarryover(getConversationIdFromStreamGenerateRequestPayload(innerPayload), attachments, {
            submittedText,
            targetIndex: Number.isInteger(meta.targetIndex) ? meta.targetIndex : null,
        });
        window.setTimeout(scheduleScan, 0);
        logDebug('Captured outgoing StreamGenerate attachments.', {
            attachmentCount: attachments.length,
            submittedText,
        });
        return true;
    }

    function maybeCaptureXhrStreamGenerateResponse(xhr) {
        const rawText = typeof xhr?.responseText === 'string' ? xhr.responseText : '';
        if (!rawText || rawText.length === xhr[XHR_STREAM_CAPTURE_LENGTH]) {
            return;
        }

        xhr[XHR_STREAM_CAPTURE_LENGTH] = rawText.length;
        maybeCaptureStreamGenerate(rawText);
    }

    function applyPendingOverride(body) {
        if (!state.pendingOverride) {
            return { applied: false, body };
        }

        if (typeof body !== 'string') {
            if (body instanceof URLSearchParams) {
                body = body.toString();
            } else {
                return { applied: false, body };
            }
        }

        try {
            const params = new URLSearchParams(body);
            const requestPayload = params.get('f.req');
            if (!requestPayload) {
                return { applied: false, body };
            }

            const outerPayload = JSON.parse(requestPayload);
            if (!Array.isArray(outerPayload) || typeof outerPayload[1] !== 'string') {
                return { applied: false, body };
            }

            const innerPayload = JSON.parse(outerPayload[1]);
            if (!Array.isArray(innerPayload) || !Array.isArray(innerPayload[2]) || !Array.isArray(innerPayload[0])) {
                return { applied: false, body };
            }

            if (state.pendingOverride.c) {
                innerPayload[2][0] = state.pendingOverride.c;
            }

            innerPayload[2][1] = state.pendingOverride.r;
            innerPayload[2][2] = state.pendingOverride.rc;
            const preservedAttachmentRecords = Array.isArray(state.pendingOverride.attachments)
                ? state.pendingOverride.attachments.map(cloneAttachmentRecord).filter(Boolean)
                : [];
            const preservedAttachments = preservedAttachmentRecords
                .map(buildAttachmentPayloadRecord)
                .filter(Boolean);
            const nativeAttachments = filterNativePayloadAttachmentsByComposerUi(
                Array.isArray(innerPayload[0][3]) ? innerPayload[0][3] : [],
                getTextInputField(),
            );
            const nativeAttachmentRecords = normalizeNativePayloadAttachments(nativeAttachments, getTextInputField());
            innerPayload[0][3] = [...preservedAttachments, ...nativeAttachments];
            logDebug('Patched StreamGenerate payload.', {
                c: innerPayload[2][0],
                r: innerPayload[2][1],
                rc: innerPayload[2][2],
                attachmentCount: innerPayload[0][3].length,
                preservedAttachmentCount: preservedAttachments.length,
                nativeAttachmentCount: nativeAttachments.length,
            });

            outerPayload[1] = JSON.stringify(innerPayload);
            params.set('f.req', JSON.stringify(outerPayload));

            return {
                applied: true,
                conversationId: innerPayload[2][0] || state.pendingOverride.c || getConversationIdFromLocation(),
                attachments: [...preservedAttachmentRecords, ...nativeAttachmentRecords],
                body: params.toString(),
            };
        } catch (error) {
            logDebugIssue('Failed to override StreamGenerate payload.', error);
            return { applied: false, body };
        }
    }

    function patchFetch() {
        if (typeof window.fetch !== 'function' || window.fetch.__geminiEditorPatched) {
            return;
        }

        const originalFetch = window.fetch;

        window.fetch = function geminiEditorFetch(input, init) {
            const url = typeof input === 'string'
                ? input
                : (input && typeof input.url === 'string' ? input.url : '');

            if (isGeminiGenerateRequest(url)) {
                const submittedText = getEditorText();
                maybeCaptureOutgoingStreamGenerate(init?.body, {
                    submittedText,
                    targetIndex: getConversationContainers().length,
                });
            }

            return originalFetch.call(this, input, init).then((response) => {
                if (isBatchExecuteRequest(url)) {
                    response.clone().text().then((rawText) => {
                        maybeCaptureConversationLoad(rawText);
                    }).catch((error) => {
                        logDebugIssue('Failed to capture batchexecute fetch response.', error);
                    });
                }

                if (isGeminiGenerateRequest(url)) {
                    response.clone().text().then((rawText) => {
                        maybeCaptureStreamGenerate(rawText);
                    }).catch((error) => {
                        logDebugIssue('Failed to capture StreamGenerate fetch response.', error);
                    });
                }

                return response;
            });
        };

        window.fetch.__geminiEditorPatched = true;
    }

    function patchXmlHttpRequest() {
        const xhrPrototype = XMLHttpRequest.prototype;
        if (
            xhrPrototype.open.__geminiEditorPatched
            || xhrPrototype.send.__geminiEditorPatched
        ) {
            return;
        }

        const originalOpen = xhrPrototype.open;
        const originalSend = xhrPrototype.send;

        xhrPrototype.open = function open(method, url) {
            this[XHR_URL] = typeof url === 'string' ? url : String(url);
            return originalOpen.apply(this, arguments);
        };

        xhrPrototype.send = function send(body) {
            let nextBody = body;

            if (!this[XHR_CAPTURE_ATTACHED] && isBatchExecuteRequest(this[XHR_URL])) {
                this.addEventListener('load', () => {
                    try {
                        maybeCaptureConversationLoad(this.responseText);
                    } catch (error) {
                        logDebugIssue('Failed to capture batchexecute XHR response.', error);
                    }
                });
                this[XHR_CAPTURE_ATTACHED] = true;
            }

            if (!this[XHR_CAPTURE_ATTACHED] && isGeminiGenerateRequest(this[XHR_URL])) {
                this.addEventListener('progress', () => {
                    try {
                        maybeCaptureXhrStreamGenerateResponse(this);
                    } catch (error) {
                        logDebugIssue('Failed to capture progressive StreamGenerate XHR response.', error);
                    }
                });
                this.addEventListener('load', () => {
                    try {
                        maybeCaptureXhrStreamGenerateResponse(this);
                    } catch (error) {
                        logDebugIssue('Failed to capture StreamGenerate XHR response.', error);
                    }
                });
                this[XHR_CAPTURE_ATTACHED] = true;
            }

            if (state.pendingOverride && isGeminiGenerateRequest(this[XHR_URL])) {
                const targetContainer = state.editTargetContainer;
                const submittedText = getEditorText();
                const pendingOverride = {
                    ...state.pendingOverride,
                    attachments: Array.isArray(state.pendingOverride.attachments)
                        ? state.pendingOverride.attachments.map(cloneAttachmentRecord).filter(Boolean)
                        : [],
                };
                const targetIndex = targetContainer
                    ? getConversationContainers().indexOf(targetContainer)
                    : null;
                logDebug('Intercepted candidate StreamGenerate request.', {
                    submittedText,
                    pendingOverride: state.pendingOverride,
                });
                const result = applyPendingOverride(body);

                if (result.applied) {
                    nextBody = result.body;
                    const submittedAttachments = Array.isArray(result.attachments)
                        ? result.attachments.map(cloneAttachmentRecord).filter(Boolean)
                        : pendingOverride.attachments;
                    setAttachmentCarryover(result.conversationId, submittedAttachments, {
                        submittedText,
                        targetIndex,
                    });
                    state.pendingOverride = null;
                    handleOverrideSuccess(targetContainer, submittedText, submittedAttachments);
                }
            } else if (isGeminiGenerateRequest(this[XHR_URL])) {
                maybeCaptureOutgoingStreamGenerate(nextBody, {
                    submittedText: getEditorText(),
                    targetIndex: getConversationContainers().length,
                });
            }

            return originalSend.call(this, nextBody);
        };

        xhrPrototype.open.__geminiEditorPatched = true;
        xhrPrototype.send.__geminiEditorPatched = true;
    }

    function bootstrap() {
        console.log(LOG_PREFIX, 'Initializing userscript.');
        patchXmlHttpRequest();
        patchFetch();
        startUiController();
        document.addEventListener('DOMContentLoaded', scheduleScan, { once: true });
    }

    bootstrap();
})();
