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

编辑 `wrangler.toml`：

- `name`：你的 worker 名称
- `[vars] UUID`：务必改成你自己的 UUID（不要使用默认值）
- `[vars] XPATH`：默认 `xhttp`，对应路由 `/{XPATH}/...`

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

> 注意：`sid` 只是会话标识，不是鉴权凭据。
