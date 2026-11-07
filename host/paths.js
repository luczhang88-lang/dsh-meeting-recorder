/**
 * 插件的 HTTP 路径常量 —— 唯一真源。
 *
 * 为什么单独一个文件：
 *   Host 半边有两处需要这些路径（transport.js 注册路由、recorder.js 生成播放 URL），
 *   各写一份字符串迟早会漂移。放在这里两边 import 同一个值。
 *
 * Client 半边是独立的浏览器 bundle，无法 import 这个文件，它的副本在 client.js
 * 顶部；改动这些路径时两边必须一起改。
 *
 * 路径规则来自 Connection 的 assertFetchRoute：
 *   必须以 /api/ 开头（/api 由 Connection 以 prefix 注册在 webServer 上），
 *   去掉 /api/ 后每一段都要匹配 /^[A-Za-z0-9_$.-]+$/，且不能为空、"."、".."。
 *
 * 为什么是多条精确路由而不是一条前缀路由：
 *   Connection 的 fetch 注册表按 url.pathname 精确匹配（源码注释写的是
 *   "Exact Fetch-route registry"），不支持通配；而 requestBody 是每条路由的属性，
 *   所以流式上传、浏览器原生 GET 回放、JSON 调用必须各有自己的路径。
 */

export const API_PREFIX = '/api/meeting-recorder';

/** JSON 接口：POST，buffered。所有请求/响应类操作都走这一条，操作用 body.op 区分。 */
export const RPC_PATH = `${API_PREFIX}/rpc`;

/** 音频上传：POST，streaming。原始 float32 字节，查询串带 sessionId。 */
export const AUDIO_PATH = `${API_PREFIX}/audio`;

/** 音频回放：GET / HEAD，buffered。支持 Range，供 <audio> 直接播放。 */
export const MEDIA_PATH = `${API_PREFIX}/media`;

/** 导入录音：POST，streaming。任意音频文件，查询串带 title / filename。 */
export const IMPORT_PATH = `${API_PREFIX}/import`;
