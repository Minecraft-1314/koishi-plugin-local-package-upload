import { Context } from '@koishijs/client'
import LocalUpload from './local-upload.vue'
import InstallProgress from './install-progress.vue'

export default (ctx: Context) => {
  ctx.slot({
    type: 'global',
    component: InstallProgress,
  })

  ctx.page({
    path: '/local-upload',
    name: '本地上传',
    desc: '上传并安装 npm pack 生成的插件包',
    icon: 'file-archive',
    position: 'bottom',
    order: 580,
    authority: 4,
    component: LocalUpload,
  })
}
