import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './auth/auth.guard';

export const routes: Routes = [
    {
        path: '',
        redirectTo: 'login',
        pathMatch: 'full'
    },
    {
        path: 'login',
        canActivate: [guestGuard],
        loadComponent: () => import('./auth/login-page.component').then(m => m.LoginPageComponent)
    },
    {
        path: 'register',
        canActivate: [guestGuard],
        loadComponent: () => import('./auth/register-page.component').then(m => m.RegisterPageComponent)
    },
    {
        path: 'account-recover',
        canActivate: [guestGuard],
        loadComponent: () => import('./auth/recover-page.component').then(m => m.RecoverPageComponent)
    },
    {
        path: 'main',
        canActivate: [authGuard],
        loadComponent: () => import('./main-window/main-window.component').then(m => m.MainWindowComponent),
        children: [
            {
                path: '',
                redirectTo: 'guide',
                pathMatch: 'full'
            },
            {
                path: 'guide',
                loadComponent: () => import('./pages/guide/guide.component').then(m => m.GuideComponent)
            },
            {
                path: 'project-new',
                loadComponent: () => import('./pages/project-new/project-new.component').then(m => m.ProjectNewComponent)
            },
            {
                path: 'playground',
                loadComponent: () => import('./pages/playground/playground.component').then(m => m.PlaygroundComponent),
                children: [
                    {
                        path: '',
                        redirectTo: 'list',
                        pathMatch: 'full'
                    },
                    {
                        path: 'list',
                        loadComponent: () => import('./pages/playground/example-list/example-list.component').then(m => m.ExampleListComponent)
                    },
                    {
                        path: 's/:name',
                        loadComponent: () => import('./pages/playground/subject-item/subject-item.component').then(m => m.SubjectItemComponent)
                    }
                ]
            },
            {
                path: 'blockly-editor',
                loadComponent: () => import('./editors/blockly-editor/blockly-editor.component').then(m => m.BlocklyEditorComponent)
            },
            {
                path: 'code-editor',
                loadComponent: () => import('./editors/code-editor/code-editor.component').then(m => m.CodeEditorComponent)
            }
        ]
    },
    // {
    //     path: 'ai-manager',
    //     loadComponent: () => import('./pages/ai-manager/ai-manager.component').then(m => m.AiManagerComponent)
    // },
    // {
    //     path:"sub",
    //     loadComponent: () => import('./sub-window/sub-window.component').then(m => m.SubWindowComponent)
    // },
    {
        path: "project-new",
        canActivate: [authGuard],
        loadComponent: () => import('./windows/project-new/project-new.component').then(m => m.ProjectNewComponent)
    },
    {
        path: "settings",
        canActivate: [authGuard],
        loadComponent: () => import('./windows/settings/settings.component').then(m => m.SettingsComponent)
    },
    {
        path: "serial-monitor",
        canActivate: [authGuard],
        loadComponent: () => import('./tools/serial-monitor/serial-monitor.component').then(m => m.SerialMonitorComponent)
    },
    {
        path: "code-viewer",
        canActivate: [authGuard],
        loadComponent: () => import('./editors/blockly-editor/tools/code-viewer/code-viewer.component').then(m => m.CodeViewerComponent)
    },
    {
        path: "simulator",
        canActivate: [authGuard],
        loadComponent: () => import('./tools/simulator/simulator.component').then(m => m.SimulatorComponent)
    },
    {
        path: "iframe",
        canActivate: [authGuard],
        loadComponent: () => import('./windows/iframe/iframe.component').then(m => m.IframeComponent)
    },
    {
        path: "graph-editor",
        canActivate: [authGuard],
        loadComponent: () => import('./editors/graph-editor/graph-editor.component').then(m => m.GraphEditorComponent)
    },
    {
        path: "model-deploy",
        canActivate: [authGuard],
        children: [
            {
                path: '',
                redirectTo: 'sscma',
                pathMatch: 'full'
            },
            // 独立测试页面（带框架）- 必须放在 :step 路由之前
            {
                path: 'sscma/test',
                loadComponent: () => import('./windows/model-deploy/sscma-config/sscma-config.component').then(m => m.SscmaConfigComponent)
            },
            // SSCMA 模型类型路由 - 支持步骤参数
            {
                path: 'sscma',
                loadComponent: () => import('./windows/model-deploy/sscma-deploy/sscma-deploy.component').then(m => m.SscmaDeployComponent)
            },
            {
                path: 'sscma/:step',
                loadComponent: () => import('./windows/model-deploy/sscma-deploy/sscma-deploy.component').then(m => m.SscmaDeployComponent)
            }
            // 未来扩展示例：
            // {
            //     path: 'chipintelli',
            //     loadComponent: () => import('./windows/model-deploy/chipintelli-deploy/chipintelli-deploy.component').then(m => m.ChipintelliDeployComponent),
            //     children: [...]
            // }
        ]
    },
    {
        path: "model-train",
        canActivate: [authGuard],
        children: [
            {
                path: '',
                loadComponent: () => import('./windows/model-train/model-train.component').then(m => m.ModelTrainComponent)
            },
            {
                path: 'vision',
                loadComponent: () => import('./windows/model-train/vision-train/vision-train.component').then(m => m.VisionTrainComponent)
            },
            {
                path: 'vision/classification',
                loadComponent: () => import('./windows/model-train/vision-train/classification-train/classification-train.component').then(m => m.ClassificationTrainComponent)
            },
            {
                path: 'vision/detection',
                loadComponent: () => import('./windows/model-train/vision-train/detection-train/detection-train.component').then(m => m.DetectionTrainComponent)
            }
            // 未来扩展：
            // {
            //     path: 'vision/pose',
            //     loadComponent: () => import('./windows/model-train/vision-train/pose-train/pose-train.component').then(m => m.PoseTrainComponent)
            // },
            // {
            //     path: 'audio',
            //     loadComponent: () => import('./windows/model-train/audio-train/audio-train.component').then(m => m.AudioTrainComponent)
            // }
        ]
    },
    {
        path: '**',
        redirectTo: 'login'
    }
];
