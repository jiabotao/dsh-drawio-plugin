---
name: drawio-diagram
description: 用 drawio(mxGraphModel XML)绘制架构图、时序图、流程图、思维导图、甘特图等图形。当用户要求"画/绘制/生成 XX 图、流程图、架构图、时序图、思维导图、甘特图、示意图"时使用。产出一段完整的 .drawio XML,交给 drawio_render 工具写盘并渲染。
---

# drawio 图形绘制指南

你产出的每一张图,都是一段完整的 `.drawio` XML(根元素 `mxfile`)。结构固定,照模板套即可。

## 最小骨架(必须照抄这两行根单元格)

```xml
<mxfile host="app.diagrams.net" type="device">
  <diagram id="p1" name="Page-1">
    <mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <!-- 你的节点和边都写在这里,parent="1" -->
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

`id="0"` 和 `id="1"` 这两行必须原样保留,它们是画布根。之后所有元素的 `parent` 都是 `1`。

## 三种基本元素

**节点(矩形框)**:`<mxCell id="唯一id" value="显示文字" style="..." vertex="1" parent="1">` + 子元素 `<mxGeometry x="100" y="100" width="120" height="60" as="geometry" />`。

**连线(边)**:`<mxCell id="e1" value="边上的文字" style="html=1;endArrow=block;" edge="1" parent="1" source="起点id" target="终点id">` + `<mxGeometry relative="1" as="geometry" />`。

**规则**:

- 所有 `id` 全局唯一;推荐用语义化名字(如 `user`、`loginApi`、`e1`),不要用 2、3、4 这种数字序列。
- `value` 里直接写中文;要换行用 `&#10;`。
- 坐标:`x` 向右增、`y` 向下增。普通节点宽约 120、高约 60;同列的节点 `x` 对齐,行间纵向间距约 80。

## 形状速查(style 字段照抄)

| 用途 | style |
|---|---|
| 普通矩形 | `rounded=0;whiteSpace=wrap;html=1;` |
| 圆角矩形(步骤/组件) | `rounded=1;arcSize=10;whiteSpace=wrap;html=1;` |
| 椭圆/圆形(开始结束) | `ellipse;whiteSpace=wrap;html=1;` |
| 菱形(判断/分支) | `rhombus;whiteSpace=wrap;html=1;` |
| 分组/泳道(架构分层) | `swimlane;html=1;startSize=30;` |
| 人物/参与者 | `shape=actor;html=1;` |
| 数据库 | `shape=cylinder3;whiteSpace=wrap;html=1;size=15;` |
| 文档 | `shape=document;whiteSpace=wrap;html=1;boundedLbl=1;` |
| 便签/说明 | `shape=note;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;` |

**配色**(追加到 style 末尾,与上面的分号隔开):

| 语义 | fillColor / strokeColor |
|---|---|
| 蓝(普通组件) | `#dae8fc` / `#6c8ebf` |
| 绿(成功/外部系统) | `#d5e8d4` / `#82b366` |
| 黄(注意/人工) | `#fff2cc` / `#d6b656` |
| 红(错误/风险) | `#f8cecc` / `#b85450` |
| 紫(中间件/总线) | `#e1d5e7` / `#9673a6` |

例:`rounded=1;arcSize=10;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;`

## 边(连线)速查

| 用途 | style |
|---|---|
| 普通实线调用 | `html=1;endArrow=block;edgeStyle=orthogonalEdgeStyle;` |
| 时序图消息(虚线箭头) | `html=1;endArrow=block;dashed=1;` |
| 自循环/返回 | `html=1;endArrow=open;dashed=1;` |
| 无箭头(依赖) | `html=1;endArrow=none;` |

## 各类图的套路

- **架构图**:用 `swimlane` 分"前端 / 网关 / 业务服务 / 数据层"几个泳道,组件放各自泳道里,实线边连依赖。
- **时序图**:顶部一排参与者(actor 或圆角矩形),每个参与者下方一条垂直虚线表示生命线;参与者之间用带文字的**水平虚线箭头**表示消息,从上到下按时间排列,`y` 依次递增 60~80。
- **流程图**:椭圆当开始/结束,圆角矩形当步骤,菱形当判断,正交实线边连接;分支边在 `value` 上标"是/否"。
- **思维导图**:中心一个椭圆,第一层用彩色圆角矩形围绕四周,普通矩形作第二层;边用无箭头实线。
- **甘特图**:每行一个 `swimlane`(任务名),任务条用一个窄圆角矩形横向摆放,`x` 表示开始时间偏移、`width` 表示工期;顶部另画一条时间刻度线。

## 完整示例:用户登录时序图

```xml
<mxfile host="app.diagrams.net" type="device">
  <diagram id="login" name="Login">
    <mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="user" value="用户" style="shape=actor;html=1;" vertex="1" parent="1">
          <mxGeometry x="80" y="40" width="40" height="80" as="geometry" />
        </mxCell>
        <mxCell id="loginPage" value="登录页" style="rounded=1;arcSize=10;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="320" y="40" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="auth" value="认证服务" style="rounded=1;arcSize=10;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
          <mxGeometry x="580" y="40" width="120" height="60" as="geometry" />
        </mxCell>
        <mxCell id="e1" value="提交账号密码" style="html=1;endArrow=block;dashed=1;" edge="1" parent="1" source="user" target="loginPage">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
        <mxCell id="e2" value="校验凭证" style="html=1;endArrow=block;dashed=1;" edge="1" parent="1" source="loginPage" target="auth">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

## 产出要求

1. 只在用户明确要画图形时调用 `drawio_render`;日常讨论不要为了画图而画图。
2. 输出的 `xml` 必须是上面那种**完整 mxfile 文档**,能被 drawio 直接打开,不要只给片段。
3. 先规划好节点数量和大致布局再写坐标,别让节点重叠。
4. 节点文案简短(≤12 字),细节放边上或备注里。
