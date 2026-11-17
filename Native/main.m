#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static void *JSONStudioWebViewTitleContext = &JSONStudioWebViewTitleContext;

@interface JSONStudioAppDelegate : NSObject <NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate>
@property (nonatomic, strong) NSWindow *window;
@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, assign) BOOL pageReady;
@property (nonatomic, assign) BOOL launchInCompareMode;
@property (nonatomic, strong) NSURL *pendingFileURL;
@end

@implementation JSONStudioAppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    self.launchInCompareMode = [[NSProcessInfo processInfo].arguments containsObject:@"--compare"];
    [self buildWindow];
    [self buildMainMenu];
    [self loadWebContent];
    [NSApp activateIgnoringOtherApps:YES];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return YES;
}

- (BOOL)applicationSupportsSecureRestorableState:(NSApplication *)app {
    return YES;
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag {
    if (!flag) {
        [self.window makeKeyAndOrderFront:nil];
    }
    return YES;
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    [self.webView removeObserver:self forKeyPath:@"title" context:JSONStudioWebViewTitleContext];
}

- (void)application:(NSApplication *)application openURLs:(NSArray<NSURL *> *)urls {
    if (urls.count == 0) return;
    [self loadURL:urls.firstObject];
    [NSApp activateIgnoringOtherApps:YES];
}

- (void)application:(NSApplication *)sender openFiles:(NSArray<NSString *> *)filenames {
    if (filenames.count == 0) return;
    [self loadURL:[NSURL fileURLWithPath:filenames.firstObject]];
    [NSApp activateIgnoringOtherApps:YES];
}

// ---------------------------------------------------------------------------
// Window & web content
// ---------------------------------------------------------------------------

- (void)buildWindow {
    NSRect visibleFrame = NSScreen.mainScreen.visibleFrame;
    CGFloat width = MIN(1360.0, MAX(1040.0, visibleFrame.size.width - 120.0));
    CGFloat height = MIN(860.0, MAX(700.0, visibleFrame.size.height - 100.0));

    NSWindowStyleMask style = NSWindowStyleMaskTitled |
                              NSWindowStyleMaskClosable |
                              NSWindowStyleMaskMiniaturizable |
                              NSWindowStyleMaskResizable;

    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, width, height)
                                              styleMask:style
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
    self.window.title = @"JSON Studio";
    self.window.subtitle = @"格式化 · 树视图 · 语义对比";
    self.window.minSize = NSMakeSize(1040, 700);
    self.window.contentMinSize = NSMakeSize(1000, 660);
    self.window.tabbingMode = NSWindowTabbingModeDisallowed;
    self.window.collectionBehavior = NSWindowCollectionBehaviorFullScreenPrimary;
    self.window.releasedWhenClosed = NO;
    [self.window setFrameAutosaveName:@"JSONStudioMainWindow"];
    [self.window center];

    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    configuration.defaultWebpagePreferences.allowsContentJavaScript = YES;
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = NO;
    configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];

    WKUserContentController *contentController = [[WKUserContentController alloc] init];
    [contentController addScriptMessageHandler:self name:@"appReady"];
    [contentController addScriptMessageHandler:self name:@"appLog"];
    configuration.userContentController = contentController;

    self.webView = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:configuration];
    self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.webView.navigationDelegate = self;
    self.webView.allowsBackForwardNavigationGestures = NO;
    self.webView.allowsLinkPreview = NO;
    self.webView.allowsMagnification = NO;
    self.webView.underPageBackgroundColor = [NSColor windowBackgroundColor];
    [self.webView addObserver:self
                   forKeyPath:@"title"
                      options:NSKeyValueObservingOptionNew
                      context:JSONStudioWebViewTitleContext];

    self.window.contentView = self.webView;
    [self.window makeKeyAndOrderFront:nil];
}

- (void)loadWebContent {
    NSURL *resources = [[NSBundle mainBundle] resourceURL];
    NSURL *indexURL = [resources URLByAppendingPathComponent:@"index.html"];
    if (![[NSFileManager defaultManager] fileExistsAtPath:indexURL.path]) {
        [self showFatalAlertWithMessage:@"无法找到应用资源 index.html，请重新构建应用。"];
        return;
    }
    [self.webView loadFileURL:indexURL allowingReadAccessToURL:resources];
}

- (void)showFatalAlertWithMessage:(NSString *)message {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.alertStyle = NSAlertStyleCritical;
    alert.messageText = @"JSON Studio 无法启动";
    alert.informativeText = message;
    [alert addButtonWithTitle:@"退出"];
    [alert runModal];
    [NSApp terminate:nil];
}

- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id> *)change
                       context:(void *)context {
    if (context == JSONStudioWebViewTitleContext && [keyPath isEqualToString:@"title"]) {
        NSString *title = self.webView.title ?: @"";
        if ([title containsString:@"对比"]) {
            self.window.subtitle = @"语义对比 · 对象 key 顺序已忽略";
        } else {
            self.window.subtitle = @"格式化 · 树视图 · 语义对比";
        }
        return;
    }
    [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
}

// ---------------------------------------------------------------------------
// JavaScript bridge
// ---------------------------------------------------------------------------

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
    if ([message.name isEqualToString:@"appReady"]) {
        self.pageReady = YES;
        NSLog(@"JSON Studio page ready");
        if (self.launchInCompareMode) {
            [self runJavaScript:@"window.JSONStudio && window.JSONStudio.setMode('compare')"];
        }
        if (self.pendingFileURL) {
            NSURL *url = self.pendingFileURL;
            self.pendingFileURL = nil;
            [self loadURL:url];
        }
        return;
    }
    if ([message.name isEqualToString:@"appLog"]) {
        id body = message.body;
        if ([body isKindOfClass:[NSDictionary class]]) {
            NSDictionary *dictionary = (NSDictionary *)body;
            NSLog(@"[JSON Studio %@] %@", dictionary[@"level"] ?: @"log", dictionary[@"message"] ?: @"");
        } else {
            NSLog(@"[JSON Studio] %@", body);
        }
    }
}

- (void)runJavaScript:(NSString *)script {
    if (!self.pageReady) return;
    [self.webView evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
        if (error) {
            NSLog(@"JavaScript error: %@", error.localizedDescription);
        }
    }];
}

- (NSString *)javaScriptLiteralForObject:(id)object {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:object
                                                   options:NSJSONWritingFragmentsAllowed
                                                     error:&error];
    if (!data) {
        NSLog(@"Could not encode JavaScript literal: %@", error);
        return @"null";
    }
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"null";
}

- (void)loadURL:(NSURL *)url {
    if (!url) return;
    if (!self.pageReady) {
        self.pendingFileURL = url;
        return;
    }

    NSNumber *isDirectory = nil;
    [url getResourceValue:&isDirectory forKey:NSURLIsDirectoryKey error:nil];
    if (isDirectory.boolValue) {
        [self showFileError:@"无法打开文件夹，请选择一个 JSON 文件。"];
        return;
    }

    NSError *readError = nil;
    NSData *data = [NSData dataWithContentsOfURL:url
                                         options:NSDataReadingMappedIfSafe
                                           error:&readError];
    if (!data) {
        [self showFileError:readError.localizedDescription ?: @"读取文件失败。"];
        return;
    }
    if (data.length > 30 * 1024 * 1024) {
        [self showFileError:@"文件超过 30 MB，建议先拆分后再导入。"];
        return;
    }

    NSString *base64 = [data base64EncodedStringWithOptions:0];
    NSString *name = url.lastPathComponent ?: @"JSON";
    NSString *script = [NSString stringWithFormat:
        @"window.JSONStudio && window.JSONStudio.loadBase64(%@, %@);",
        [self javaScriptLiteralForObject:base64],
        [self javaScriptLiteralForObject:name]];
    [self runJavaScript:script];
}

- (void)showFileError:(NSString *)message {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.alertStyle = NSAlertStyleWarning;
    alert.messageText = @"无法导入 JSON";
    alert.informativeText = message;
    [alert addButtonWithTitle:@"好"];
    if (self.window) {
        [alert beginSheetModalForWindow:self.window completionHandler:nil];
    } else {
        [alert runModal];
    }
}

// ---------------------------------------------------------------------------
// Menu actions
// ---------------------------------------------------------------------------

- (void)openDocument:(id)sender {
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.canChooseFiles = YES;
    panel.canChooseDirectories = NO;
    panel.allowsMultipleSelection = NO;
    panel.allowedContentTypes = @[UTTypeJSON, UTTypePlainText];
    panel.message = @"选择要导入当前编辑器的 JSON 文件";
    panel.prompt = @"导入";
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        if (result == NSModalResponseOK && panel.URL) {
            [self loadURL:panel.URL];
        }
    }];
}

- (void)formatActive:(id)sender {
    [self runJavaScript:@"window.JSONStudio && window.JSONStudio.formatActive()"];
}

- (void)minifyActive:(id)sender {
    [self runJavaScript:@"window.JSONStudio && window.JSONStudio.minifyActive()"];
}

- (void)openUnescape:(id)sender {
    [self runJavaScript:@"window.JSONStudio && window.JSONStudio.openUnescape()"];
}

- (void)formatMode:(id)sender {
    [self runJavaScript:@"window.JSONStudio && window.JSONStudio.setMode('format')"];
}

- (void)compareMode:(id)sender {
    [self runJavaScript:@"window.JSONStudio && window.JSONStudio.setMode('compare')"];
}

- (void)compareNow:(id)sender {
    [self runJavaScript:@"window.JSONStudio && window.JSONStudio.compareNow()"];
}

- (void)showShortcuts:(id)sender {
    [self runJavaScript:@"window.JSONStudio && window.JSONStudio.showShortcuts()"];
}

- (void)exportPlaceholder:(id)sender {
}

- (BOOL)validateMenuItem:(NSMenuItem *)menuItem {
    SEL action = menuItem.action;
    if (action == @selector(formatActive:) ||
        action == @selector(minifyActive:) ||
        action == @selector(openUnescape:) ||
        action == @selector(formatMode:) ||
        action == @selector(compareMode:) ||
        action == @selector(compareNow:) ||
        action == @selector(showShortcuts:)) {
        return self.pageReady;
    }
    return YES;
}

// ---------------------------------------------------------------------------
// Menu construction
// ---------------------------------------------------------------------------

- (NSMenuItem *)addItemToMenu:(NSMenu *)menu
                        title:(NSString *)title
                       action:(SEL)action
                          key:(NSString *)key
                    modifiers:(NSEventModifierFlags)modifiers
                       target:(id)target {
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:action keyEquivalent:key];
    item.keyEquivalentModifierMask = modifiers;
    if (target) item.target = target;
    [menu addItem:item];
    return item;
}

- (void)buildMainMenu {
    NSMenu *mainMenu = [[NSMenu alloc] initWithTitle:@"Main Menu"];

    // Application menu
    NSMenuItem *appMenuItem = [[NSMenuItem alloc] initWithTitle:@"JSON Studio" action:nil keyEquivalent:@""];
    [mainMenu addItem:appMenuItem];
    NSMenu *appMenu = [[NSMenu alloc] initWithTitle:@"JSON Studio"];
    appMenuItem.submenu = appMenu;

    [self addItemToMenu:appMenu title:@"关于 JSON Studio" action:@selector(orderFrontStandardAboutPanel:) key:@"" modifiers:0 target:nil];
    [appMenu addItem:[NSMenuItem separatorItem]];

    NSMenuItem *servicesItem = [[NSMenuItem alloc] initWithTitle:@"服务" action:nil keyEquivalent:@""];
    NSMenu *servicesMenu = [[NSMenu alloc] initWithTitle:@"服务"];
    servicesItem.submenu = servicesMenu;
    [appMenu addItem:servicesItem];
    [NSApp setServicesMenu:servicesMenu];

    [appMenu addItem:[NSMenuItem separatorItem]];
    [self addItemToMenu:appMenu title:@"隐藏 JSON Studio" action:@selector(hide:) key:@"h" modifiers:NSEventModifierFlagCommand target:nil];
    [self addItemToMenu:appMenu title:@"隐藏其他" action:@selector(hideOtherApplications:) key:@"h" modifiers:(NSEventModifierFlagCommand | NSEventModifierFlagOption) target:nil];
    [self addItemToMenu:appMenu title:@"全部显示" action:@selector(unhideAllApplications:) key:@"" modifiers:0 target:nil];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [self addItemToMenu:appMenu title:@"退出 JSON Studio" action:@selector(terminate:) key:@"q" modifiers:NSEventModifierFlagCommand target:nil];

    // File menu
    NSMenuItem *fileMenuItem = [[NSMenuItem alloc] initWithTitle:@"文件" action:nil keyEquivalent:@""];
    [mainMenu addItem:fileMenuItem];
    NSMenu *fileMenu = [[NSMenu alloc] initWithTitle:@"文件"];
    fileMenuItem.submenu = fileMenu;
    [self addItemToMenu:fileMenu title:@"打开 JSON…" action:@selector(openDocument:) key:@"o" modifiers:NSEventModifierFlagCommand target:self];
    [fileMenu addItem:[NSMenuItem separatorItem]];
    [self addItemToMenu:fileMenu title:@"关闭窗口" action:@selector(performClose:) key:@"w" modifiers:NSEventModifierFlagCommand target:nil];

    // Edit menu
    NSMenuItem *editMenuItem = [[NSMenuItem alloc] initWithTitle:@"编辑" action:nil keyEquivalent:@""];
    [mainMenu addItem:editMenuItem];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"编辑"];
    editMenuItem.submenu = editMenu;
    [self addItemToMenu:editMenu title:@"撤销" action:@selector(undo:) key:@"z" modifiers:NSEventModifierFlagCommand target:nil];
    [self addItemToMenu:editMenu title:@"重做" action:@selector(redo:) key:@"z" modifiers:(NSEventModifierFlagCommand | NSEventModifierFlagShift) target:nil];
    [editMenu addItem:[NSMenuItem separatorItem]];
    [self addItemToMenu:editMenu title:@"剪切" action:@selector(cut:) key:@"x" modifiers:NSEventModifierFlagCommand target:nil];
    [self addItemToMenu:editMenu title:@"拷贝" action:@selector(copy:) key:@"c" modifiers:NSEventModifierFlagCommand target:nil];
    [self addItemToMenu:editMenu title:@"粘贴" action:@selector(paste:) key:@"v" modifiers:NSEventModifierFlagCommand target:nil];
    [self addItemToMenu:editMenu title:@"全选" action:@selector(selectAll:) key:@"a" modifiers:NSEventModifierFlagCommand target:nil];

    // JSON menu
    NSMenuItem *jsonMenuItem = [[NSMenuItem alloc] initWithTitle:@"JSON" action:nil keyEquivalent:@""];
    [mainMenu addItem:jsonMenuItem];
    NSMenu *jsonMenu = [[NSMenu alloc] initWithTitle:@"JSON"];
    jsonMenuItem.submenu = jsonMenu;
    [self addItemToMenu:jsonMenu title:@"格式化当前 JSON" action:@selector(formatActive:) key:@"f" modifiers:(NSEventModifierFlagCommand | NSEventModifierFlagShift) target:self];
    [self addItemToMenu:jsonMenu title:@"压缩当前 JSON" action:@selector(minifyActive:) key:@"m" modifiers:(NSEventModifierFlagCommand | NSEventModifierFlagShift) target:self];
    [self addItemToMenu:jsonMenu title:@"Unescape String…" action:@selector(openUnescape:) key:@"u" modifiers:(NSEventModifierFlagCommand | NSEventModifierFlagShift) target:self];
    [jsonMenu addItem:[NSMenuItem separatorItem]];
    [self addItemToMenu:jsonMenu title:@"格式化模式" action:@selector(formatMode:) key:@"1" modifiers:NSEventModifierFlagCommand target:self];
    [self addItemToMenu:jsonMenu title:@"对比模式" action:@selector(compareMode:) key:@"2" modifiers:NSEventModifierFlagCommand target:self];
    [jsonMenu addItem:[NSMenuItem separatorItem]];
    [self addItemToMenu:jsonMenu title:@"立即比较" action:@selector(compareNow:) key:@"\r" modifiers:NSEventModifierFlagCommand target:self];

    // View menu
    NSMenuItem *viewMenuItem = [[NSMenuItem alloc] initWithTitle:@"显示" action:nil keyEquivalent:@""];
    [mainMenu addItem:viewMenuItem];
    NSMenu *viewMenu = [[NSMenu alloc] initWithTitle:@"显示"];
    viewMenuItem.submenu = viewMenu;
    [self addItemToMenu:viewMenu title:@"进入全屏" action:@selector(toggleFullScreen:) key:@"f" modifiers:(NSEventModifierFlagCommand | NSEventModifierFlagControl) target:nil];

    // Window menu
    NSMenuItem *windowMenuItem = [[NSMenuItem alloc] initWithTitle:@"窗口" action:nil keyEquivalent:@""];
    [mainMenu addItem:windowMenuItem];
    NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:@"窗口"];
    windowMenuItem.submenu = windowMenu;
    [self addItemToMenu:windowMenu title:@"最小化" action:@selector(performMiniaturize:) key:@"m" modifiers:NSEventModifierFlagCommand target:nil];
    [self addItemToMenu:windowMenu title:@"缩放" action:@selector(performZoom:) key:@"" modifiers:0 target:nil];
    [windowMenu addItem:[NSMenuItem separatorItem]];
    [self addItemToMenu:windowMenu title:@"前置全部窗口" action:@selector(arrangeInFront:) key:@"" modifiers:0 target:nil];
    [NSApp setWindowsMenu:windowMenu];

    // Help menu
    NSMenuItem *helpMenuItem = [[NSMenuItem alloc] initWithTitle:@"帮助" action:nil keyEquivalent:@""];
    [mainMenu addItem:helpMenuItem];
    NSMenu *helpMenu = [[NSMenu alloc] initWithTitle:@"帮助"];
    helpMenuItem.submenu = helpMenu;
    [self addItemToMenu:helpMenu title:@"键盘快捷键" action:@selector(showShortcuts:) key:@"/" modifiers:NSEventModifierFlagCommand target:self];
    [NSApp setHelpMenu:helpMenu];

    [NSApp setMainMenu:mainMenu];
}

// ---------------------------------------------------------------------------
// WKNavigationDelegate
// ---------------------------------------------------------------------------

- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = navigationAction.request.URL;
    if (!url) {
        decisionHandler(WKNavigationActionPolicyAllow);
        return;
    }
    if ([url.scheme isEqualToString:@"about"]) {
        decisionHandler(WKNavigationActionPolicyAllow);
        return;
    }
    if (url.isFileURL) {
        NSString *indexPath = [[[NSBundle mainBundle] resourceURL] URLByAppendingPathComponent:@"index.html"].path;
        if ([url.path isEqualToString:indexPath]) {
            decisionHandler(WKNavigationActionPolicyAllow);
        } else {
            decisionHandler(WKNavigationActionPolicyCancel);
        }
        return;
    }
    if ([url.scheme isEqualToString:@"http"] || [url.scheme isEqualToString:@"https"]) {
        [[NSWorkspace sharedWorkspace] openURL:url];
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }
    decisionHandler(WKNavigationActionPolicyCancel);
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    NSLog(@"JSON Studio UI loaded");
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    NSLog(@"JSON Studio navigation failed: %@", error);
    if (error.code != NSURLErrorCancelled) {
        [self showFatalAlertWithMessage:error.localizedDescription ?: @"加载界面失败。"];
    }
}

@end

static JSONStudioAppDelegate *gAppDelegate = nil;

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *application = [NSApplication sharedApplication];
        gAppDelegate = [[JSONStudioAppDelegate alloc] init];
        application.delegate = gAppDelegate;
        [application run];
    }
    return 0;
}
