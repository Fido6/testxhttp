# Cloudflare Workers 版本 xhttp packet-up

依赖（Durable Objects + TCP Sockets）

链接格式：
```
vless://58888888-8888-8888-8888-888888888888@your.deploy.workers.dev:443?encryption=none&security=tls&sni=your.deploy.workers.dev&fp=firefox&alpn=h3&insecure=0&allowInsecure=0&type=xhttp&host=your.deploy.workers.dev&path=%2Fxhttp&mode=packet-up
```


>  特殊提醒：xhttp packet-up 虽无grpc、websocket需求，但是连接速度非常慢，不建议用作主力协议；
  Worker不支持UDP协议所以客户端dns请尝试使用DNS OVER TCP/HTTPS/TLS，不要使用常规DNS OVER UDP

> 如果要使用worker域名，alpn要选`h3`（xray 用户狂喜）

> [Nekobox for android mod](https://github.com/starifly/NekoBoxForAndroid) 用户请注意，由于mod版本的bug，xhttp传输方式下 **应用层协议协商/alpn** 不能选择h3，只能选择`http/1.1`,`h2`,所以就要求必须绑定自定义域名，除非你用pages反代workers

> 宇宙安全声明：使用者在下载或使用本项目代码时，必须严格遵守所在地区的法律法规，并需要在测试完成后 24 小时内删除本项目相关部署。


## 部署前提

**一个正常 的cloudflare账号(不用验证信用卡，能够直接部署worker的账号)**

> 说明：本地 `wrangler dev`/workerd 对部分 compatibility flags 的支持可能与线上不同。
> 如果你在本地看到类似 `No such compatibility flag: tcp_sockets`，可以先移除该 flag 让服务启动，
> 再以实际运行时是否支持 `cloudflare:sockets` 为准进行验证。

## 配置（wrangler）
复制示例：

```bash
cp wrangler.toml.example wrangler.toml
```

编辑 [`wrangler.toml`](wrangler.toml:1)：

- `name`：你的 worker 名称
- `[vars] K_SIGIL`：务必改成你自己的值（原本的 UUID，不要使用默认值）
- `[vars] P_SIGIL`：默认 `xhttp`（原本的 `XPATH`），对应路由 `/{XPATH}/...`
- `[vars] PROXY_URL`：可选，上游代理地址
  - 直连回退：`tcp://proxy.example.com:443`
  - HTTP CONNECT：`http://proxy.example.com:3128`
  - HTTPS CONNECT：`https://proxy.example.com:443`
  - SOCKS5：`socks5://proxy.example.com:1080`
  - 带账号密码：`http://user:pass@proxy.example.com:3128` 或 `socks5://user:pass@proxy.example.com:1080`

> 说明：`PROXY_URL` 会自动按 scheme 识别协议。
> - `http(s)://`：走 HTTP 代理（未测试）
> - `socks5://`：走 SOCKS5代理（未测试）
> - `tcp://` / `proxy://` / `direct://`：走直连回退模式(proxyip)
>
> 也支持通过 **查询参数临时覆盖**（适用于环境变量里的 `PROXY_URL` 临时不可用时应急切换）：
> - `/{XPATH}?PURL=tcp://exam.ple:443`
> - `/{XPATH}?PURL=socks5://user:pass@www.socks:1256`
> - `/{XPATH}?PURL=http://user:pass@proxy.example.com:3128`
>
> 注意：该覆盖只对“该 sid 的会话初始化前”生效；如果连接已建立，后续再传 `PURL` 不会切换现有连接。

## 本地运行/发布

```bash
npx wrangler dev
# 或
npx wrangler deploy
```

## 路由

- `/`：返回 `Hello, World`
- `/{XPATH}/{sid}`：GET 建立下行流
- `/{XPATH}/{sid}/{seq}`：POST 上传分片

> 注意：`sid` 只是会话标识，不是鉴权凭据。生产环境建议把 `sid` 设计成不可猜测（例如随机 128-bit），或者在路径/头里加入额外鉴权 token。

