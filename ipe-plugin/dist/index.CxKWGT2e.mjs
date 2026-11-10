// ipe-plugin/src/index.ts
var e = () => window.mw, t = (t) => e()?.config?.get?.(t), n = () => e()?.util, r = () => window.jQuery;
function i() {
	let e = n();
	return e && typeof e.wikiScript == "function" ? e.wikiScript("api") : new URL("/api.php", location.origin).href;
}
var a = {
	name: "vscode-editor",
	inject: [
		"quickEdit",
		"quickUpload",
		"templatesUsed",
		"quickDiff"
	],
	apply(a) {
		let o = i(), s = null, c = !1, l = null, u, d = 0, f, p = !1, m = null, h = null, ee = 0, g = {}, _ = null, v = null, te = 0, y = {};
		function b() {
			if (document.getElementById("mwe-ipe-guard-style")) return;
			let e = document.createElement("style");
			e.id = "mwe-ipe-guard-style", e.textContent = ".ipe-modal-modal__window.ipe-quickEdit{display:none!important;}\n.ipe-modal-backdrop:has(+ .ipe-modal-modal .ipe-quickEdit){display:none!important;}", document.head.append(e);
		}
		let x = "mwe-ipe-bar-style";
		function S() {
			if (document.getElementById(x)) return;
			let e = document.createElement("style");
			e.id = x, e.textContent = ".mwe-ipe-bar{position:fixed;left:0;right:0;bottom:0;z-index:2147483001;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#fff;border-top:2px solid #3366cc;padding:10px 16px;box-shadow:0 -2px 12px rgba(0,0,0,.15);font-size:14px;color:#202122;}\n.mwe-ipe-bar .mwe-ipe-status{flex:1 1 180px;color:#72777d;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}\n.mwe-ipe-bar .mwe-ipe-status.error{color:#d33;}\n.mwe-ipe-bar .mwe-ipe-status.ok{color:#14866d;}\n.mwe-ipe-bar input[type=text]{flex:1 1 220px;min-width:160px;padding:6px 10px;border:1px solid #a2a9b1;border-radius:4px;font-size:14px;}\n.mwe-ipe-bar select{padding:6px 10px;border:1px solid #a2a9b1;border-radius:4px;background:#fff;font-size:14px;color:#202122;}\n.mwe-ipe-bar button{padding:6px 14px;border-radius:4px;border:1px solid #a2a9b1;background:#f8f9fa;cursor:pointer;font-size:14px;color:#202122;}\n.mwe-ipe-bar button:hover{background:#eaecf0;}\n.mwe-ipe-bar button.is-primary{background:#3366cc;border-color:#3366cc;color:#fff;font-weight:600;}\n.mwe-ipe-bar button.is-primary:hover{background:#2a56a8;}\n.mwe-ipe-bar .mwe-ipe-link{color:#3366cc;font-size:13px;text-decoration:none;cursor:pointer;white-space:nowrap;}\n.mwe-ipe-bar .mwe-ipe-link:hover{text-decoration:underline;}\n.mwe-ipe-bar label{display:flex;align-items:center;gap:4px;white-space:nowrap;}\nbody.mwe-ipe-editing{padding-bottom:96px;}", document.head.append(e);
		}
		function ne() {
			let e = document.querySelector(".mwe-ipe-bar");
			if (!e || !l) return;
			let t = e.querySelector(".mwe-ipe-submit");
			t && (t.disabled = !!l.remoteDirty || !!l.busy), l.remoteDirty && w("VSCode 里有未保存修改，先保存文件（Ctrl+S）");
		}
		function C(e) {
			l && (l.busy = !!e);
			let t = document.querySelector(".mwe-ipe-bar");
			t && (t.querySelectorAll("button").forEach((t) => {
				t.disabled = !!e;
			}), e && w("提交中…"));
		}
		function w(e, t) {
			let n = document.querySelector(".mwe-ipe-status");
			n && (n.textContent = e || "", n.className = "mwe-ipe-status" + (t ? " " + t : ""));
		}
		function T() {
			S();
			let e = document.querySelector(".mwe-ipe-bar");
			return e || (e = document.createElement("div"), e.className = "mwe-ipe-bar", e.innerHTML = "<span class=\"mwe-ipe-status\">VSCode 编辑中</span><input type=\"text\" class=\"mwe-ipe-summary\" placeholder=\"编辑摘要\"><select class=\"mwe-ipe-watchlist\"><option value=\"preferences\">遵循 MW 首选</option><option value=\"nochange\">保持当前状态</option><option value=\"watch\">添加到监视列表</option><option value=\"unwatch\">从监视列表移除</option></select><label><input type=\"checkbox\" class=\"mwe-ipe-minor\"> 小编辑</label><label><input type=\"checkbox\" class=\"mwe-ipe-reload\" checked> 保存后刷新</label><button class=\"mwe-ipe-submit is-primary\">提交</button><button class=\"mwe-ipe-diff\">差异</button><a class=\"mwe-ipe-link mwe-ipe-upload\">快速上传</a><a class=\"mwe-ipe-link mwe-ipe-templates\">使用的模板</a><a class=\"mwe-ipe-link mwe-ipe-images\">使用的图片</a><button class=\"mwe-ipe-cancel\">取消</button>", document.body.append(e), document.body.classList.add("mwe-ipe-editing"), e.querySelector(".mwe-ipe-submit")?.addEventListener("click", () => {
				ue(e);
			}), e.querySelector(".mwe-ipe-cancel")?.addEventListener("click", () => {
				le();
			}), e.querySelector(".mwe-ipe-upload")?.addEventListener("click", () => {
				let e = a.quickUpload;
				e && e.showModal();
			}), e.querySelector(".mwe-ipe-templates")?.addEventListener("click", () => {
				if (!l) return;
				let e = a.templatesUsed;
				e && e.showModal({ title: l.title });
			}), e.querySelector(".mwe-ipe-images")?.addEventListener("click", () => {
				ce();
			}), e.querySelector(".mwe-ipe-diff")?.addEventListener("click", () => {
				if (!l) return;
				let e = a.quickDiff;
				if (!e) return;
				let t = l.wikiPage.revisions[0]?.content || "";
				t !== l.text && e.comparePages({
					fromtitle: l.title,
					fromtext: t,
					totitle: l.title,
					totext: l.text,
					topst: !0
				});
			}), e);
		}
		function E(e, t) {
			w(e, t);
		}
		function D(e) {
			return fetch(o, {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams(Object.assign({
					format: "json",
					formatversion: "2"
				}, e))
			}).then((e) => e.json());
		}
		function O() {
			let e = {
				action: "query",
				meta: "siteinfo",
				siprop: "general|namespaces|namespacealiases|magicwords|functionhooks|extensiontags|variables|interwikimap",
				format: "json",
				formatversion: "2"
			}, t = typeof AbortController == "function" ? new AbortController() : null, n = t ? window.setTimeout(() => t.abort(), 2e4) : null;
			return fetch(o + "?" + new URLSearchParams(e), {
				credentials: "include",
				signal: t ? t.signal : void 0
			}).then((e) => {
				if (!e.ok) throw Error("HTTP " + e.status);
				return e.json();
			}).then((e) => {
				if (e.error) throw Error(e.error.code + ": " + e.error.info);
				if (!e.query || !e.query.general) throw Error("站点没有返回 siteinfo");
				return e.query;
			}).finally(() => {
				n && clearTimeout(n);
			});
		}
		function k(e, t) {
			let n = e || "VSCode 扩展未连接。请手动打开 VSCode，并确认已安装并启用 MediaWiki 扩展。", r = a.modal;
			if (r && typeof r.notify == "function") {
				r.notify("warning", {
					title: t || "VSCode 未连接",
					content: n,
					position: "top right",
					closeAfter: {
						time: 8e3,
						resetOnHover: !0
					}
				});
				return;
			}
			let i = document.getElementById("mwe-offline-notice");
			i && i.remove();
			let o = document.createElement("div");
			o.id = "mwe-offline-notice", o.style.cssText = "position:fixed;top:20px;right:20px;z-index:2147483003;max-width:360px;background:#fff;color:#202122;border:1px solid #a2a9b1;border-left:4px solid #fc3;padding:12px 14px;border-radius:4px;font-size:13px;line-height:1.5;box-shadow:0 2px 12px rgba(0,0,0,.2);", o.textContent = n, document.body.append(o), window.setTimeout(() => o.remove(), 8e3);
		}
		function re(e) {
			let t = document.createElement("a");
			t.href = e, t.target = "_blank", t.rel = "noopener", t.textContent = "打开目标页面", t.style.cssText = "color:#36c;text-decoration:underline;cursor:pointer;";
			let n = a.modal;
			n && typeof n.notify == "function" ? n.notify("warning", {
				title: "弹窗被拦截",
				content: t,
				position: "top right",
				closeAfter: {
					time: 1e4,
					resetOnHover: !0
				}
			}) : k("弹窗被拦截，请手动打开目标页面。", "需要打开页面");
		}
		function A(e) {
			let t;
			try {
				t = new URL(n().getUrl(e.title), location.href);
			} catch {
				N({
					type: "open-result",
					requestId: e.requestId,
					opened: !1
				});
				return;
			}
			t.searchParams.set("external-editor", "1"), e.fragment && (t.hash = e.fragment);
			let r = "mwe-edit:" + encodeURIComponent(e.title), i = null;
			try {
				i = window.open(t.href, r);
			} catch {}
			if (!i) re(t.href), N({
				type: "open-result",
				requestId: e.requestId,
				opened: !1
			});
			else {
				try {
					i.focus();
				} catch {}
				N({
					type: "open-result",
					requestId: e.requestId,
					opened: !0
				});
			}
		}
		function j() {
			return m ? Promise.resolve(m) : h || (h = O().then((e) => {
				let n = "reg-" + Date.now() + "-" + ++ee;
				return new Promise((r, i) => {
					let a = window.setTimeout(() => {
						delete g[n], i(/* @__PURE__ */ Error("扩展未响应站点注册"));
					}, 15e3);
					g[n] = {
						resolve: r,
						reject: i,
						timer: a,
						query: e
					}, N({
						type: "register-wiki",
						requestId: n,
						origin: location.origin,
						api: o,
						name: t("wgSiteName") || location.host,
						siteinfo: e
					});
				});
			}).then((e) => (m = e, h = null, e)).catch((e) => {
				throw h = null, e;
			}), h);
		}
		function ie(e) {
			let t = g[e.requestId];
			t && (clearTimeout(t.timer), delete g[e.requestId], e.ok ? t.resolve(t.query) : t.reject(Error(e.error || "站点注册失败")));
		}
		function M() {
			p || s && s.readyState <= WebSocket.OPEN || (s = new WebSocket("ws://127.0.0.1:8927"), s.addEventListener("open", () => {
				c = !0;
				let e = document.getElementById("mwe-offline-notice");
				e && e.remove(), (async () => {
					try {
						await j();
						let e = await J();
						if (e) {
							await Y(e), _ = null;
							return;
						}
					} catch (e) {
						E("站点注册失败：" + (e instanceof Error ? e.message : String(e)), "error");
					}
					if (l) K(), q(), k("扩展没有该会话，已退出编辑态。", "会话已结束");
					else if (_) {
						let e = _;
						_ = null, X(e).catch((e) => {
							E("启动失败：" + (e instanceof Error ? e.message : String(e)), "error");
						});
					}
				})();
			}), s.addEventListener("close", () => {
				c = !1, v = null, p || (f = window.setTimeout(M, 5e3));
			}), s.addEventListener("error", () => {
				try {
					s?.close();
				} catch {}
			}), s.addEventListener("message", (e) => {
				let t;
				try {
					t = JSON.parse(e.data);
				} catch {
					return;
				}
				t.type === "wiki-registered" ? ie(t) : t.type === "session-result" ? se(t) : t.type === "navigate-edit" ? A(t) : l && t.sessionId === l.id && (t.type === "update" ? (l.text = t.text, l.changed = !0, U()) : t.type === "state" ? (l.remoteDirty = !!t.dirty, ne()) : t.type === "scroll" ? I(t.text, t.occurrence, t.scope, t.label, t.prev, t.next, t.labelOccurrence) : t.type === "save" ? (w("正在提交…"), de(t.text, t.summary, t.minor)) : t.type === "finish" ? (t.result === "closed" && K(), q(), window.name.indexOf("mwe-edit:") === 0 && t.result !== "closed" && window.setTimeout(() => window.close(), 50)) : t.type === "editor-closed" ? (K(), q(), k("编辑器已关闭，草稿已保留。", "编辑器已关闭")) : t.type === "preempted" && (K(), q(), k("已在另一个标签继续编辑。", "会话已转移")));
			}));
		}
		function N(e) {
			return s && s.readyState === WebSocket.OPEN ? (s.send(JSON.stringify(e)), !0) : !1;
		}
		function P(e) {
			if (!e || !e.width && !e.height) return !1;
			let t = e.top + window.scrollY, n = e.left + window.scrollX;
			window.scrollTo({
				top: Math.max(0, t - window.innerHeight / 2 + e.height / 2),
				behavior: "auto"
			});
			let r = document.createElement("div");
			return r.style.cssText = "position:absolute;left:" + n + "px;top:" + t + "px;width:" + e.width + "px;height:" + e.height + "px;pointer-events:none;z-index:2147482999;outline:2px solid #3366cc;background:rgba(51,102,204,.15);border-radius:2px;", document.body.append(r), window.setTimeout(() => r.remove(), 1600), !0;
		}
		function ae(e) {
			let t = e;
			for (; t && t !== document.body;) {
				if (window.getComputedStyle(t).display === "none") {
					let e = t.querySelector(".mw-collapsible-toggle a");
					return e ? (e.click(), !0) : (t.style.display = "", !0);
				}
				t = t.parentElement;
			}
			return !1;
		}
		function oe(e) {
			let t = document.createTreeWalker(e, NodeFilter.SHOW_TEXT), n = [], r = "", i;
			for (; i = t.nextNode();) {
				let e = i.parentElement;
				if (e && e.closest("script,style,.vc-preview")) continue;
				let t = r.length;
				r += i.nodeValue || "", n.push({
					node: i,
					start: t,
					end: r.length
				});
			}
			let a = "", o = [], s = !1;
			for (let e = 0; e < r.length; e++) /\s/.test(r[e]) ? s ||= (a += " ", o.push(e), !0) : (a += r[e], o.push(e), s = !1);
			return {
				nodes: n,
				norm: a,
				map: o
			};
		}
		function F(e, t, n) {
			let r = String(t || "").replace(/\s+/g, " ").trim();
			if (!r) return null;
			let i = -1, a = 0;
			for (; (i = e.norm.indexOf(r, i + 1)) >= 0;) {
				if (a++, a < n) continue;
				let t = e.map[i], o = (e.map[Math.min(i + r.length - 1, e.map.length - 1)] || t) + 1, s = e.nodes.find((e) => t >= e.start && t < e.end), c = e.nodes.find((e) => o <= e.end && o > e.start);
				if (!s || !c) continue;
				let l = document.createRange();
				return l.setStart(s.node, t - s.start), l.setEnd(c.node, o - c.start), l;
			}
			return null;
		}
		function I(e, t, n, r, i, a, o) {
			if (!e) return !1;
			let s = document.querySelector("#mw-content-text");
			if (!s) return !1;
			let c = s;
			if (n && n.type === "poem") {
				let e = s.querySelectorAll(".poem")[n.index];
				if (!e) return !1;
				c = e;
			}
			let l = Math.max(1, Number(t) || 1), u = [];
			function d(e, t) {
				let n = String(e || "").replace(/\s+/g, " ").trim();
				n.length < 2 || u.some((e) => e.needle === n) || u.push({
					needle: n,
					occurrence: t
				});
			}
			n || (r && (d(r + " " + e, o || 1), d(r + e, o || 1)), a && (d(e + " " + a, 1), d(e + a, 1)), i && (d(i + " " + e, 1), d(i + e, 1))), d(e, l);
			let f = oe(c);
			for (let e of u) {
				let t = F(f, e.needle, e.occurrence);
				if (!t) continue;
				let n = t.getBoundingClientRect();
				if (n && (n.width || n.height)) {
					if (P(n)) return !0;
					continue;
				}
				let r = t.startContainer.parentElement;
				if (r && ae(r)) return window.setTimeout(() => {
					let t = F(f, e.needle, e.occurrence);
					t && P(t.getBoundingClientRect());
				}, 150), !0;
			}
			return !1;
		}
		function L(e) {
			try {
				let t = new URL(e, location.href);
				return t.searchParams.set("external-editor", "1"), t.href;
			} catch {
				return e;
			}
		}
		function R() {
			let e = new URL(location.href);
			if (e.searchParams.get("external-editor") !== "1") return null;
			let t = e.searchParams.get("external-editor-section");
			e.searchParams.delete("external-editor"), e.searchParams.delete("external-editor-section");
			try {
				history.replaceState(null, "", e.pathname + e.search + e.hash);
			} catch {}
			return { section: t == null || t === "" ? void 0 : Number(t) };
		}
		function z(e) {
			if (e.closest(".mw-editsection") || e.classList.contains("new") || e.classList.contains("external")) return !1;
			let t = new URL(e.href, location.href);
			if (t.origin !== location.origin) return !1;
			let n = t.searchParams;
			return !(n.get("action") || n.get("oldid") || n.get("diff") || n.get("redlink") || t.pathname.indexOf("/Special:") >= 0 || t.pathname.indexOf("特殊:") >= 0 || t.pathname === location.pathname && t.hash);
		}
		function B(e, t) {
			let n = null, r = document;
			if (r.caretRangeFromPoint) n = r.caretRangeFromPoint(e, t);
			else if (r.caretPositionFromPoint) {
				let i = r.caretPositionFromPoint(e, t);
				i && (n = document.createRange(), n.setStart(i.offsetNode, i.offset), n.collapse(!0));
			}
			if (!n || !n.startContainer || n.startContainer.nodeType !== Node.TEXT_NODE) return null;
			let i = n.startContainer.nodeValue || "", a = n.startOffset || 0, o = i.slice(Math.max(0, a - 40), Math.min(i.length, a + 40)).replace(/\s+/g, " ").trim();
			return o.length >= 2 ? o : null;
		}
		function V(e) {
			e && e.querySelectorAll("script").forEach((e) => {
				if (e.dataset.mweExecuted) return;
				let t = document.createElement("script");
				for (let n of Array.from(e.attributes)) t.setAttribute(n.name, n.value);
				t.textContent = e.textContent, t.dataset.mweExecuted = "1", e.replaceWith(t);
			});
		}
		function H(t) {
			let n = document.querySelector("#mw-content-text");
			if (!n) return;
			l && !l.fullOriginal && (l.fullOriginal = Array.from(n.childNodes));
			let i = document.createElement("div");
			i.innerHTML = t, n.replaceChildren(...Array.from(i.childNodes)), V(n);
			let a = e();
			a?.hook && typeof r() == "function" && a.hook("wikipage.content").fire(r()(n));
		}
		function U() {
			clearTimeout(u), u = window.setTimeout(W, 250);
		}
		async function W() {
			if (!l) return;
			if (l.section != null) {
				w("VSCode 编辑中（章节预览暂不支持）");
				return;
			}
			let e = ++d, t = {
				action: "parse",
				contentmodel: "wikitext",
				title: l.title,
				text: l.text,
				pst: "1",
				preview: "1",
				disableeditsection: "1",
				disablelimitreport: "1",
				prop: "text"
			}, n;
			try {
				n = await D(t);
			} catch (t) {
				e === d && E("预览失败：" + (t instanceof Error ? t.message : String(t)));
				return;
			}
			e === d && n.parse && (H(n.parse.text), w("预览已更新 " + (/* @__PURE__ */ new Date()).toLocaleTimeString()));
		}
		function G(e) {
			if (l && (l.changed || l.remoteDirty)) return e.preventDefault(), e.returnValue = "还有未提交的修改，确定离开？", e.returnValue;
		}
		function K() {
			let e = document.querySelector("#mw-content-text");
			e && l && l.fullOriginal && (e.replaceChildren(...l.fullOriginal), l.fullOriginal = void 0);
		}
		function q() {
			l = null, clearTimeout(u), window.removeEventListener("beforeunload", G);
			let e = document.querySelector(".mwe-ipe-bar");
			e && e.remove(), document.body.classList.remove("mwe-ipe-editing");
		}
		function J() {
			if (v) return v;
			if (!c) return Promise.resolve(null);
			let e = "session-" + Date.now() + "-" + ++te;
			return v = new Promise((n, r) => {
				let i = window.setTimeout(() => {
					delete y[e], r(/* @__PURE__ */ Error("扩展未响应会话查询"));
				}, 8e3);
				y[e] = {
					resolve: n,
					reject: r,
					timer: i
				}, N({
					type: "session-query",
					requestId: e,
					origin: location.origin,
					title: t("wgPageName")
				}) || (clearTimeout(i), delete y[e], r(/* @__PURE__ */ Error("扩展未连接")));
			}).catch((e) => {
				throw v = null, e;
			}), v;
		}
		function se(e) {
			let t = y[e.requestId];
			t && (clearTimeout(t.timer), delete y[e.requestId], e.ok ? t.resolve(e.session || null) : t.reject(Error(e.error || "会话查询失败")));
		}
		async function Y(e) {
			if (!e || l) return;
			let t;
			try {
				t = e.revid ? await a.wikiPage.newFromRevision(e.revid, e.section) : await a.wikiPage.newFromTitle(e.title, !1, e.section);
			} catch (e) {
				E("恢复会话失败：" + (e instanceof Error ? e.message : String(e)), "error");
				return;
			}
			t ? (l = {
				id: e.sessionId,
				title: e.title,
				section: e.section,
				text: e.text,
				wikiPage: t,
				remoteDirty: !!e.dirty,
				changed: !1,
				busy: !1
			}, window.addEventListener("beforeunload", G), Z(null), document.body.classList.remove("ipe-modal-no-scroll"), w("已恢复 VSCode 编辑会话"), U()) : E("无法恢复编辑会话：InPageEdit wikiPage 不可用", "error");
		}
		async function X(e) {
			let t = e.options, n = e.modal, r = e.wikiPage;
			if (l) return;
			if (!c) {
				_ = e, k();
				return;
			}
			try {
				await j();
				let e = await J();
				if (e) {
					await Y(e);
					return;
				}
			} catch (e) {
				let t = "站点注册失败：" + (e instanceof Error ? e.message : String(e)) + "。请更新网页端脚本并刷新页面。";
				E(t), k(t, "站点注册失败");
				return;
			}
			let i = r.revisions?.[0];
			l = {
				id: "s" + Date.now(),
				title: r.pageInfo?.title || t.title,
				section: t.section,
				text: i && i.content || "",
				wikiPage: r,
				remoteDirty: !1,
				changed: !1,
				busy: !1
			}, window.addEventListener("beforeunload", G), Z(n), document.body.classList.remove("ipe-modal-no-scroll"), w("VSCode 编辑中，保存文件即刷新预览"), N({
				type: "open",
				sessionId: l.id,
				title: l.title,
				section: l.section,
				text: l.text,
				revid: i && i.revid,
				basetimestamp: i && i.timestamp,
				starttimestamp: (/* @__PURE__ */ new Date()).toISOString(),
				wiki: location.origin
			});
		}
		function ce() {
			if (!l) return;
			let e = a.modal;
			e && fetch(o + "?action=parse&format=json&formatversion=2&prop=images&page=" + encodeURIComponent(l.title)).then((e) => e.json()).then((t) => {
				let n = t.parse && t.parse.images || [], r = document.createElement("div");
				if (!n.length) r.textContent = "没有使用的图片。";
				else {
					let e = document.createElement("ol");
					n.forEach((t) => {
						let n = /^File:/i.test(t) ? t : "File:" + t, r = document.createElement("li"), i = document.createElement("a");
						i.href = "/wiki/" + encodeURIComponent(n), i.target = "_blank", i.rel = "noopener", i.textContent = n, r.append(i), e.append(r);
					}), r.append(e);
				}
				e.show({
					title: "使用的图片",
					content: r,
					sizeClass: "dialog",
					draggable: !0,
					backdrop: !1
				});
			});
		}
		function le() {
			if (!l) return;
			let e = l.remoteDirty || l.changed;
			if (!e || confirm(l.remoteDirty ? "VSCode 里还有未保存的修改，放弃并关闭编辑器？" : "还有未提交到站点的修改，确定放弃？")) {
				try {
					N({
						type: "finish",
						sessionId: l.id,
						result: e ? "discarded" : "unchanged"
					});
				} catch {}
				window.removeEventListener("beforeunload", G), K(), q();
			}
		}
		function Z(e) {
			try {
				e && e.close();
			} catch {}
			T();
		}
		function ue(e) {
			if (!l) return;
			if (l.remoteDirty) {
				w("VSCode 里有未保存修改，先保存文件（Ctrl+S）", "error");
				return;
			}
			C(!0);
			let t = e.querySelector(".mwe-ipe-summary"), n = e.querySelector(".mwe-ipe-minor"), r = e.querySelector(".mwe-ipe-watchlist"), i = e.querySelector(".mwe-ipe-reload");
			l.watchlist = r ? r.value : "nochange", l.reload = !!(i && i.checked), w("正在保存文件…"), N({
				type: "request-save",
				sessionId: l.id,
				summary: t ? t.value : "",
				minor: !!(n && n.checked)
			});
		}
		async function de(e, t, n) {
			if (l) try {
				await l.wikiPage.edit({
					text: e,
					summary: t || "",
					minor: !!n,
					section: l.section,
					watchlist: l.watchlist || "nochange"
				}), window.removeEventListener("beforeunload", G), N({
					type: "save-result",
					sessionId: l.id,
					ok: !0
				}), N({
					type: "finish",
					sessionId: l.id,
					result: "saved",
					summary: t || "",
					minor: !!n
				}), w(l.reload === !1 ? "已保存" : "已保存，正在刷新…", "ok"), C(!1), l.reload !== !1 && window.setTimeout(() => location.reload(), 800);
			} catch (e) {
				let t = e instanceof Error ? e.message : String(e);
				C(!1), N({
					type: "save-result",
					sessionId: l.id,
					ok: !1,
					error: t
				}), w("保存失败：" + t, "error");
			}
		}
		function Q(e) {
			if (!l) return;
			let t = e.target;
			if (t?.closest && !t.closest("#mw-content-text")) return;
			let n = t?.closest?.("a");
			if (n) {
				if (!z(n)) return;
				e.preventDefault(), window.open(L(n.href), "_blank", "noopener");
				return;
			}
			let r = B(e.clientX, e.clientY);
			r && N({
				type: "locate",
				sessionId: l.id,
				text: r
			});
		}
		b(), M(), a.on("quick-edit/show-modal", (e) => {
			try {
				e.modal.close();
			} catch {}
			document.body.classList.remove("ipe-modal-no-scroll");
		}), a.on("quick-edit/wiki-page", (e) => {
			X(e).catch((e) => {
				E("启动失败：" + (e instanceof Error ? e.message : String(e)));
			});
		}), document.addEventListener("click", Q, !0), a.on("dispose", () => {
			p = !0, c = !1, clearTimeout(f), clearTimeout(u);
			for (let e of Object.keys(g)) clearTimeout(g[e].timer), delete g[e];
			for (let e of Object.keys(y)) clearTimeout(y[e].timer), delete y[e];
			try {
				s?.close();
			} catch {}
			s = null, document.removeEventListener("click", Q, !0), K(), q(), document.getElementById("mwe-ipe-guard-style")?.remove(), document.getElementById(x)?.remove(), document.getElementById("mwe-offline-notice")?.remove();
		});
		let $ = R();
		$ && window.setTimeout(() => {
			if (!p) try {
				let e = t("wgPageName");
				if (!e) throw Error("无法读取当前页面标题");
				if (typeof a.quickEdit != "function") throw Error("InPageEdit 缺少 quickEdit");
				a.quickEdit({
					title: e,
					section: $.section
				});
			} catch (e) {
				E("自动进入编辑失败：" + (e instanceof Error ? e.message : String(e)), "error");
			}
		}, 0);
	}
};
export { a as default };
