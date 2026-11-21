import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SystemStatus } from '@aerotrack/shared';

@Component({
  imports: [RouterOutlet, SystemStatus],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {}
