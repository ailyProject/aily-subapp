import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render title', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.serial-monitor-shell')).toBeTruthy();
  });

  it('should render Agent serial state and traffic received outside Angular events', async () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    (app as unknown as { bootstrap: () => Promise<void> }).bootstrap = async () => undefined;
    fixture.detectChanges();
    (app as unknown as { hydratingHistory: boolean }).hydratingHistory = false;
    const deliver = (message: Record<string, unknown>) => {
      (app as unknown as { handleBackendMessage: (raw: string) => void })
        .handleBackendMessage(JSON.stringify(message));
    };

    deliver({
      event: 'serial.opened',
      seq: 1,
      actor: 'agent',
      timestamp: Date.now(),
      data: {
        connected: true,
        portPath: 'COM3',
        rxBytes: 0,
        txBytes: 0,
        pid: 1234,
        signals: {}
      }
    });
    deliver({
      event: 'serial.tx',
      seq: 2,
      actor: 'agent',
      timestamp: Date.now(),
      data: {
        text: 'hello esp32s3\n',
        hex: '68 65 6c 6c 6f',
        byteLength: 14,
        txBytes: 14
      }
    });
    deliver({
      event: 'serial.rx',
      seq: 3,
      actor: 'device',
      timestamp: Date.now(),
      data: {
        text: 'hello esp32s3\n\r\n',
        hex: '68 65 6c 6c 6f',
        byteLength: 16,
        rxBytes: 16
      }
    });

    await fixture.whenStable();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('COM3');
    expect(compiled.textContent).toContain('Agent controlled');
    expect(compiled.textContent).toContain('hello esp32s3');
    expect(compiled.querySelectorAll('.data-item').length).toBeGreaterThanOrEqual(3);
  });
});
