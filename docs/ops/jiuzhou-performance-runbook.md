# 九州服务性能只读诊断手册

## 目标

用于确认卡顿来自整机资源、Node 事件循环、数据库、Redis、网络连接，还是业务热点路径。

## 禁止操作

- 不重启容器。
- 不修改 Docker service。
- 不执行数据库 DDL/DML。
- 不清理 Redis。
- 不执行 Git 操作。

## 基础采样

```bash
hostname; whoami; date; uptime; uname -a
nproc
free -m
vmstat 1 5
iostat -xz 1 5
docker stats --no-stream
docker ps --format 'table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
```

## Node 主线程判断

```bash
ps -eo pid,ppid,user,stat,psr,pcpu,pmem,rss,vsz,etimes,comm,args --sort=-pcpu | head -30
pidstat -u -p <node-pid> 1 6
pidstat -t -u -p <node-pid> 1 6
```

## 慢日志聚合

```bash
docker logs --since 30m <jiuzhou_server_container_id> 2>&1 \
  | sed -r 's/\x1B\[[0-9;]*[mK]//g' \
  | awk '
    /http.slow-request/ {slow_http++}
    /slow-operation/ {slow_op++}
    /UserConnectionSlots/ {slots++}
    END {
      print "slow_http", slow_http+0;
      print "slow_operation", slow_op+0;
      print "user_slot_queue", slots+0;
    }'
```

## Postgres 当前状态

```bash
docker exec <postgres_container_id> psql -U postgres -d jiuzhou -c "
select state, wait_event_type, wait_event, count(*)
from pg_stat_activity
group by state, wait_event_type, wait_event
order by count(*) desc;"
```

## Postgres 累计热点

```bash
docker exec <postgres_container_id> psql -U postgres -d jiuzhou -c "
select calls,
       round(total_exec_time::numeric,2) as total_ms,
       round(mean_exec_time::numeric,2) as mean_ms,
       rows,
       left(query, 180) as query
from pg_stat_statements
order by total_exec_time desc
limit 20;"
```
