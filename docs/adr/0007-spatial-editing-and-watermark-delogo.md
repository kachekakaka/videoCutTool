# 0007. 画面空间编辑（画幅裁切、去水印与遮罩）与自动转码升轨架构决策

> 状态：空间编辑与原生滤镜选型有效；2026-10-28 明确精确导出适用边界，撤销固定包体积、单文件便携与秒开承诺。

## Context

用户需要调整画幅、去除静态台标或遮挡局部内容。时间轴与选框同时操作容易误触，而修改画面像素必然需要视频重新编码。引入大型 AI 模型及独立运行环境会增加分发和维护成本。

## Decision

- 工作台分为时间剪辑与画面处理视图，后者再区分裁切和去水印／遮罩；两者共用草稿，降低手势干扰。
- 画面参数默认全片生效，允许单段覆盖；切点变化时由 [RetentionDraft](../../src/shared/RetentionDraft.ts)维护配置继承，不用片段序号猜测归属。
- 使用 FFmpeg 原生滤镜处理静态区域，避免新增 AI 运行环境。遮罩在原片坐标定位，先处理区域再裁切，防止移动裁切框带动遮罩漂移。滤镜实现见 [spatialFiltergraph](../../src/shared/spatialFiltergraph.ts)。
- 同一输出文件的不同尺寸片段统一画布，独立输出则保留各自尺寸；分组语义见 [Output File Group](../../CONTEXT.md#output-file-group)。

## Consequences

原生区域修补依赖周边像素，不能承诺恢复被遮挡的真实内容或跟踪任意运动目标。画面处理与时间编辑可一并保存、执行，但仍需验证分段差异和输出组合。

早期“只要有画面处理就强制智能降码”已收窄：关键帧模式需要转入智能降码，精确模式已重新编码，可以直接结合画面处理，详见 [Transcode Auto-Escalation](../../CONTEXT.md#transcode-auto-escalation)。早期 50MB、单文件便携秒开的表述不是现行产品约束；发行方式见 [ADR 0002](0002-portable-distribution-and-user-data-setup.md)。
