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
        path: '**',
        redirectTo: 'login'
    }
];
